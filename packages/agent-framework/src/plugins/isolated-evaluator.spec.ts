import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaunchRequest, ProcessLauncher } from "@zeta-agent/process";
import {
  PluginEvaluationError,
  createPluginSource,
  evaluatePluginSource,
  translateIsolatedContributions,
  type EvalChild,
  type EvalSpawn,
  type InvocationGate,
  type IsolatedPlugin,
  type PluginProcessLauncher,
} from "./isolated-evaluator";

const KEYS = [
  "__T13_TOPLEVEL",
  "__T13_PROCESS",
  "__T13_REQUIRE",
  "__T13_FETCH",
  "__T13_FILE",
  "__T13_ESCAPE",
  "__T13_HOSTPROC",
  "__T13_INSTALL_HOST",
  "__T13_HOOK_HOST",
];

function clearHostMarkers(): void {
  for (const key of KEYS) delete (globalThis as Record<string, unknown>)[key];
}

function handlerId(plugin: IsolatedPlugin, kind: string): string {
  const record = plugin.report.capabilities.find((item) => item.kind === kind && item.handlerId !== undefined);
  if (record?.handlerId === undefined) throw new Error(`missing handler for ${kind}`);
  return record.handlerId;
}

async function close(plugin: IsolatedPlugin | undefined): Promise<void> {
  if (plugin !== undefined && !plugin.closed) await plugin.terminate();
}

function completedEvalChild(digest: string): EvalChild {
  return {
    stdin: { write(_data: string) {}, end() {} },
    stdout: (async function* () {
      yield JSON.stringify({
        t: "result",
        ok: true,
        contributions: [],
        installRegistered: false,
        handlerIds: [],
        digest,
      }) + String.fromCharCode(10);
    })(),
    stderr: null,
    exited: Promise.resolve(0),
    kill() {},
  };
}

describe("T-13 隔离求值：顶层代码只在子进程执行", () => {
  test("宿主 process/require/fetch 在 vm 中不可达，顶层副作用不污染宿主", async () => {
    clearHostMarkers();
    const plugin = await evaluatePluginSource(
      createPluginSource(
        "probe",
        `
        globalThis.__T13_TOPLEVEL = true;
        globalThis.__T13_PROCESS = typeof globalThis.process;
        globalThis.__T13_REQUIRE = typeof globalThis.require;
        globalThis.__T13_FETCH = typeof globalThis.fetch;
        api.addSection("alive");
        `,
        { trusted: true }
      )
    );
    try {
      expect((globalThis as Record<string, unknown>).__T13_TOPLEVEL).toBeUndefined();
      expect((globalThis as Record<string, unknown>).__T13_PROCESS).toBeUndefined();
      expect((globalThis as Record<string, unknown>).__T13_REQUIRE).toBeUndefined();
      expect((globalThis as Record<string, unknown>).__T13_FETCH).toBeUndefined();
      expect(plugin.contributions.some((item) => item.kind === "section")).toBe(true);
      expect(plugin.report.topLevelExecution).toBe("child-vm");
      expect(plugin.report.digestVerified).toBe(true);
    } finally {
      await close(plugin);
      clearHostMarkers();
    }
  });

  test("process.exit 调用被阻断，子进程求值继续返回数据贡献", async () => {
    const plugin = await evaluatePluginSource(
      createPluginSource(
        "exit",
        `
        try { globalThis.process.exit(7); } catch (error) {}
        api.addSection("still-alive");
        `,
        { trusted: true }
      )
    );
    try {
      expect(plugin.contributions).toHaveLength(1);
      expect(plugin.report.termination).toBe("confirmed");
    } finally {
      await close(plugin);
    }
  });

  test("require fs 写宿主文件被阻断", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zeta-t13-escape-"));
    const target = join(dir, "pwned.txt");
    try {
      const plugin = await evaluatePluginSource(
        createPluginSource(
          "file",
          `
          try { require("node:fs").writeFileSync(${JSON.stringify(target)}, "pwned"); } catch (error) {}
          api.addSection("safe");
          `,
          { trusted: true }
        )
      );
      expect(existsSync(target)).toBe(false);
      await close(plugin);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("globalThis.constructor.constructor 逃逸被 codeGeneration 关闭阻断", async () => {
    clearHostMarkers();
    const plugin = await evaluatePluginSource(
      createPluginSource(
        "ctor",
        `
        function attempt() {
          try {
            const F = globalThis.constructor.constructor;
            const hostProcess = F("return process")();
            return { escaped: true, hostProcess: typeof hostProcess };
          } catch (error) { return { escaped: false, reason: "BLOCKED" }; }
        }
        api.registerTool({ name: "probe", execute: function () { return attempt(); } });
        api.addSection("safe");
        `,
        { trusted: true }
      )
    );
    try {
      const result = await plugin.invoke(handlerId(plugin, "tool"), {});
      expect(result.ok).toBe(true);
      expect(result.value).toEqual({ escaped: false, reason: "BLOCKED" });
      expect((globalThis as Record<string, unknown>).__T13_HOSTPROC).toBeUndefined();
      expect(plugin.contributions).toHaveLength(2);
    } finally {
      await close(plugin);
      clearHostMarkers();
    }
  });

  test("fetch 出站被阻断，本地端点不会被触达", async () => {
    const hits: string[] = [];
    const server = createServer((_request, response) => {
      hits.push("hit");
      response.writeHead(200);
      response.end("ok");
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
    const port = (server.address() as { port: number }).port;
    try {
      const plugin = await evaluatePluginSource(
        createPluginSource(
          "net",
          `
          try { fetch("http://127.0.0.1:${port}/escape"); } catch (error) {}
          api.addSection("safe");
          `,
          { trusted: true }
        )
      );
      expect(hits).toEqual([]);
      await close(plugin);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  test("install / hook 逃逸代码只在子进程闭包内，宿主无安装/钩子副作用", async () => {
    clearHostMarkers();
    const plugin = await evaluatePluginSource(
      createPluginSource(
        "handlers",
        `
        api.addSection("safe");
        api.on("agent_start", function () { globalThis.__T13_HOOK_HOST = true; });
        api.onInstall(function () { globalThis.__T13_INSTALL_HOST = true; });
        `,
        { trusted: false }
      ),
      { allowUntrustedEvaluation: true }
    );
    try {
      const installResult = await plugin.invoke("install", undefined);
      const hookResult = await plugin.invoke(handlerId(plugin, "hook"), { type: "agent_start" });
      expect(installResult.ok).toBe(true);
      expect(hookResult.ok).toBe(true);
      expect((globalThis as Record<string, unknown>).__T13_INSTALL_HOST).toBeUndefined();
      expect((globalThis as Record<string, unknown>).__T13_HOOK_HOST).toBeUndefined();
      expect(plugin.trusted).toBe(false);
      for (const capability of plugin.report.capabilities) {
        expect(capability.executableInHost).toBe(false);
        expect(capability.executionPath).toBe("host-data");
      }
    } finally {
      await close(plugin);
      clearHostMarkers();
    }
  });
});

describe("F-T13-01 求值前安全门与进程启动边界", () => {
  test("untrusted 默认拒绝且 launcher spawn=0", async () => {
    let spawned = 0;
    const launcher: PluginProcessLauncher = {
      spawn() {
        spawned += 1;
        throw new Error("SHOULD_NOT_SPAWN");
      },
    };
    const source = createPluginSource("untrusted-default", "api.addSection(\"blocked\");");

    await expect(evaluatePluginSource(source, { launcher })).rejects.toThrow(
      "PLUGIN_UNTRUSTED_EVALUATION_DENIED"
    );
    expect(spawned).toBe(0);
  });

  test("allowUntrustedEvaluation 显式放行不可信源码并调用 launcher", async () => {
    const source = createPluginSource("untrusted-allowed", "api.addSection(\"allowed\");", {
      trusted: false,
    });
    let spawned = 0;
    let command: string | undefined;
    let args: readonly string[] | undefined;
    const launcher: PluginProcessLauncher = {
      spawn(nextCommand, nextArgs) {
        spawned += 1;
        command = nextCommand;
        args = nextArgs;
        return completedEvalChild(source.digest);
      },
    };

    const plugin = await evaluatePluginSource(source, {
      launcher,
      allowUntrustedEvaluation: true,
    });
    try {
      expect(spawned).toBe(1);
      expect(command).toBe(process.execPath);
      expect(args?.[1]?.endsWith("eval-worker.mjs")).toBe(true);
      expect(plugin.trusted).toBe(false);
    } finally {
      await close(plugin);
    }
  });

  test("beforeEvaluate 在 launcher.spawn 前执行", async () => {
    const source = createPluginSource("policy-order", "api.addSection(\"ok\");", { trusted: true });
    const calls: string[] = [];
    const launcher: PluginProcessLauncher = {
      spawn() {
        calls.push("spawn");
        return completedEvalChild(source.digest);
      },
    };

    const plugin = await evaluatePluginSource(source, {
      launcher,
      async beforeEvaluate(checked) {
        await Promise.resolve();
        expect(checked.digest).toBe(source.digest);
        calls.push("beforeEvaluate");
      },
    });
    try {
      expect(calls).toEqual(["beforeEvaluate", "spawn"]);
    } finally {
      await close(plugin);
    }
  });

  test("beforeEvaluate 抛错时失败关闭且 launcher spawn=0", async () => {
    const source = createPluginSource("policy-denied", "api.addSection(\"blocked\");", {
      trusted: true,
    });
    let spawned = 0;
    const launcher: PluginProcessLauncher = {
      spawn() {
        spawned += 1;
        throw new Error("SHOULD_NOT_SPAWN");
      },
    };

    await expect(
      evaluatePluginSource(source, {
        launcher,
        beforeEvaluate() {
          throw new Error("POLICY_DENIED");
        },
      })
    ).rejects.toThrow("POLICY_DENIED");
    expect(spawned).toBe(0);
  });

  test("worker 默认只继承最小白名单，不继承 secret 环境", async () => {
    const source = createPluginSource("env-default", "api.addSection(\"ok\");", { trusted: true });
    const secretKey = "__ZETA_EVAL_SECRET__";
    const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
    const previousSecret = process.env[secretKey];
    const previousPath = process.env[pathKey];
    process.env[secretKey] = "host-secret";
    process.env[pathKey] = "minimal-path";
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const launcher: PluginProcessLauncher = {
      spawn(_command, _args, options) {
        capturedEnv = options.env;
        return completedEvalChild(source.digest);
      },
    };

    try {
      const plugin = await evaluatePluginSource(source, { launcher });
      try {
        expect(capturedEnv?.PATH).toBe("minimal-path");
        expect(capturedEnv?.[secretKey]).toBeUndefined();
        expect(capturedEnv?.NODE_OPTIONS).toBeUndefined();
      } finally {
        await close(plugin);
      }
    } finally {
      if (previousSecret === undefined) delete process.env[secretKey];
      else process.env[secretKey] = previousSecret;
      if (previousPath === undefined) delete process.env[pathKey];
      else process.env[pathKey] = previousPath;
    }
  });

  test("调用方显式 env 也按最小白名单过滤", async () => {
    const source = createPluginSource("env-explicit", "api.addSection(\"ok\");", { trusted: true });
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const launcher: PluginProcessLauncher = {
      spawn(_command, _args, options) {
        capturedEnv = options.env;
        return completedEvalChild(source.digest);
      },
    };

    const plugin = await evaluatePluginSource(source, {
      launcher,
      env: {
        PATH: "caller-path",
        __ZETA_EVAL_SECRET__: "caller-secret",
        NODE_OPTIONS: "--require=forbidden",
      },
    });
    try {
      expect(capturedEnv).toEqual({ PATH: "caller-path" });
    } finally {
      await close(plugin);
    }
  });

  test("统一 processLauncher 注入生效且收到真实 worker argv", async () => {
    const digest = "digest";
    const requests: LaunchRequest[] = [];
    const launcher: ProcessLauncher = {
      name: "fake-unified-launcher",
      confinement: "none",
      launch(request) {
        requests.push(request);
        const child = completedEvalChild("digest");
        return {
          pid: 1,
          stdin: child.stdin,
          stdout: (async function* () {
            yield Buffer.from(JSON.stringify({
              t: "result",
              ok: true,
              contributions: [],
              installRegistered: false,
              handlerIds: [],
              digest,
            }) + "\n");
          })(),
          stderr: null,
          exited: child.exited,
          kill: child.kill,
        };
      },
    };
    const source = createPluginSource("unified-launcher", 'api.addSection("ok");', { trusted: true });
    const plugin = await evaluatePluginSource(source, { processLauncher: launcher });
    try {
      expect(requests).toHaveLength(1);
      expect(requests[0]!.command).toBe(process.execPath);
      expect(requests[0]!.args[1]).toContain("eval-worker.mjs");
      expect(requests[0]!.env?.NODE_OPTIONS).toBeUndefined();
    } finally {
      await close(plugin);
    }
  });

  test("旧 spawnImpl 注入点保持兼容", async () => {
    const source = createPluginSource("spawn-compat", "api.addSection(\"ok\");", { trusted: true });
    let spawned = 0;
    const spawnImpl: EvalSpawn = () => {
      spawned += 1;
      return completedEvalChild(source.digest);
    };

    const plugin = await evaluatePluginSource(source, { spawnImpl });
    try {
      expect(spawned).toBe(1);
    } finally {
      await close(plugin);
    }
  });
});

describe("T-13 隔离求值：摘要校验、资源上限与对账", () => {
  test("digest 篡改/格式非法/长度非法立即拒绝，且不创建子进程", async () => {
    const base = createPluginSource("digest", 'api.addSection("ok");', { trusted: true });
    let spawned = 0;
    const spawnImpl = (() => {
      throw new Error("SHOULD_NOT_SPAWN");
    }) as never;
    void spawned;
    await expect(
      evaluatePluginSource({ ...base, digest: `sha256:${"0".repeat(64)}` }, { spawnImpl })
    ).rejects.toThrow("PLUGIN_DIGEST_MISMATCH");
    await expect(
      evaluatePluginSource({ ...base, digest: "sha256:not-hex" }, { spawnImpl })
    ).rejects.toThrow("PLUGIN_DIGEST_INVALID_FORMAT");
    await expect(
      evaluatePluginSource({ ...base, source: "" }, { spawnImpl })
    ).rejects.toThrow("PLUGIN_SOURCE_LENGTH_INVALID");
  });

  test("顶层无限循环触发超时，返回 unknown 且带 DO_NOT_RETRY 对账标记", async () => {
    let error: PluginEvaluationError | undefined;
    try {
      await evaluatePluginSource(
        createPluginSource("loop", "while (true) {}", {
          trusted: true,
          limits: { timeoutMs: 120, invokeTimeoutMs: 200, maxOldSpaceMb: 64 },
        })
      );
    } catch (caught) {
      error = caught as PluginEvaluationError;
    }
    expect(error).toBeInstanceOf(PluginEvaluationError);
    expect(error?.code).toBe("PLUGIN_EVAL_TIMEOUT");
    expect(error?.termination).toBe("unknown");
    expect(error?.reconciliation).toContain("DO_NOT_RETRY");
  });

  test("外部取消触发失败关闭与 unknown 对账，不普通重试", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30);
    let error: PluginEvaluationError | undefined;
    try {
      await evaluatePluginSource(
        createPluginSource("slow", "while (true) {}", {
          trusted: true,
          limits: { timeoutMs: 500, invokeTimeoutMs: 200 },
        }),
        { signal: controller.signal }
      );
    } catch (caught) {
      error = caught as PluginEvaluationError;
    } finally {
      clearTimeout(timer);
    }
    expect(error?.code).toBe("PLUGIN_EVAL_ABORTED");
    expect(error?.termination).toBe("unknown");
    expect(error?.reconciliation).toContain("DO_NOT_RETRY");
  });

  test("handler 永不 settle 时按 unknown 对账终止，不重试", async () => {
    const plugin = await evaluatePluginSource(
      createPluginSource(
        "hang",
        `api.registerTool({ name: "hang", execute: function () { return new Promise(function () {}); } });`,
        { trusted: true, limits: { timeoutMs: 2000, invokeTimeoutMs: 80 } }
      )
    );
    try {
      const result = await plugin.invoke(handlerId(plugin, "tool"), {});
      expect(result.ok).toBe(false);
      expect(result.error).toContain("PLUGIN_INVOKE_TIMEOUT");
      expect(result.reconciliation).toContain("DO_NOT_RETRY");
      expect(plugin.report.termination).toBe("unknown");
      expect(plugin.closed).toBe(true);
    } finally {
      await close(plugin);
    }
  });

  test("贡献数量上限拒绝超大结果", async () => {
    let error: PluginEvaluationError | undefined;
    try {
      await evaluatePluginSource(
        createPluginSource(
          "many",
          `for (var i = 0; i < 50; i += 1) api.addSection("s" + i);`,
          { trusted: true, limits: { timeoutMs: 1000, maxContributions: 5 } }
        )
      );
    } catch (caught) {
      error = caught as PluginEvaluationError;
    }
    expect(error?.code).toBe("PLUGIN_CONTRIBUTION_LIMIT");
  });
});

describe("T-13 隔离求值：trusted 正向路径与受限代理", () => {
  test("可信插件的 tool/install/hook 经 IPC 真执行，section 为数据贡献", async () => {
    const plugin = await evaluatePluginSource(
      createPluginSource(
        "good",
        `
        api.addSection("TRUSTED SECTION");
        api.registerTool({
          name: "add",
          parameters: [{ name: "a", type: "number", required: true }],
          execute: function (input) { return { sum: input.a + 1 }; }
        });
        api.on("agent_start", function (event) { return event.type; });
        api.onInstall(function () { return "installed"; });
        `,
        { trusted: true }
      )
    );
    try {
      expect(plugin.trusted).toBe(true);
      expect(plugin.installRegistered).toBe(true);
      expect(plugin.report.capabilities.find((item) => item.kind === "tool")?.executionPath).toBe("child-vm-ipc");

      const translated = translateIsolatedContributions(plugin);
      const tool = translated.find((item) => item.kind === "tool");
      expect(tool).toBeDefined();
      if (tool?.kind !== "tool") throw new Error("missing tool");
      expect(tool.tool.name).toBe("add");
      expect(tool.tool.parameters?.[0]?.name).toBe("a");
      const execute = tool.tool.execute as (input: unknown) => unknown;
      expect(await execute({ a: 1 })).toEqual({ sum: 2 });

      plugin.install();
      const installResult = await plugin.installPromise;
      expect(installResult?.ok).toBe(true);
      expect(installResult?.value).toBe("installed");

      const hookResult = await plugin.invoke(handlerId(plugin, "hook"), { type: "agent_start" });
      expect(hookResult.ok).toBe(true);
      expect(hookResult.value).toBe("agent_start");
    } finally {
      await close(plugin);
    }
  });

  test("InvocationGate 在 IPC 之前拒绝调用，宿主不触达子进程", async () => {
    const calls: string[] = [];
    const gate: InvocationGate = {
      check(request) {
        calls.push(`${request.kind}:${request.handlerId}`);
        if (typeof (request.event as { readonly url?: unknown } | undefined)?.url === "string") {
          throw new Error("EGRESS_DENIED");
        }
      },
    };
    const plugin = await evaluatePluginSource(
      createPluginSource(
        "gated",
        `api.registerTool({ name: "net", execute: function () { return "reached"; } });`,
        { trusted: true }
      ),
      { invocationGate: gate }
    );
    try {
      const denied = await plugin.invoke(handlerId(plugin, "tool"), { url: "http://example.test" });
      expect(denied.ok).toBe(false);
      expect(denied.error).toBe("EGRESS_DENIED");
      expect(calls).toHaveLength(1);

      const allowed = await plugin.invoke(handlerId(plugin, "tool"), {});
      expect(allowed.ok).toBe(true);
      expect(allowed.value).toBe("reached");
      expect(calls).toHaveLength(2);
    } finally {
      await close(plugin);
    }
  });

  test("terminate 明确终止子进程并报告 confirmed", async () => {
    const plugin = await evaluatePluginSource(
      createPluginSource("term", `api.addSection("x");`, { trusted: true })
    );
    const state = await plugin.terminate();
    expect(state.termination).toBe("confirmed");
    expect(plugin.closed).toBe(true);
    expect(plugin.report.termination).toBe("confirmed");
  });

  test("临时文件写入 fixture 自身可用（确保逃逸测试的文件断言非假阳性）", () => {
    const dir = mkdtempSync(join(tmpdir(), "zeta-t13-control-"));
    const target = join(dir, "control.txt");
    writeFileSync(target, "ok");
    expect(existsSync(target)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
    expect(existsSync(target)).toBe(false);
  });
});
