import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLocalSafeBackend,
  createStructuredRecordingBackend,
  type Capabilities,
  type SpawnImpl,
} from "@zeta-agent/security";
import { builtinToolDefinitions, type ToolResourceLimits } from "./builtins";

const ACTIVE: Capabilities = Object.freeze({
  isolation: "active",
  seccomp: "active",
  fsConfinement: "active",
  auditSink: "active",
  egressDefaultDeny: "active",
});

/** T-12：read/grep/find 资源上限与 bash/powershell 的结构化 shell 入口。 */
describe("T-12 builtin 工具资源上限", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "zeta-t12-limits-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const backend = () => createStructuredRecordingBackend({ allowedDirectories: [root] });

  async function call(
    name: string,
    args: Record<string, unknown>,
    options: {
      limits?: ToolResourceLimits;
      now?: () => number;
    } = {}
  ): Promise<Record<string, unknown>> {
    const b = backend();
    const definitions = builtinToolDefinitions({
      securityBackend: b,
      structuredBackend: b,
      allowedDirectories: [root],
      ...(options.limits === undefined ? {} : { limits: options.limits }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    const definition = definitions.find((item) => item.name === name);
    expect(definition).toBeDefined();
    return (await definition!.execute(args)) as Record<string, unknown>;
  }

  test("read 字节上限：超限显式 truncated，内容按 UTF-8 字节截断", async () => {
    const file = join(root, "read.txt");
    writeFileSync(file, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "utf8");
    const result = await call("read", { path: file }, { limits: { maxReadBytes: 8 } });
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(String(result.content), "utf8")).toBeLessThanOrEqual(8);
  });

  test("grep 行数上限：匹配列表被截断并标记", async () => {
    const file = join(root, "grep.txt");
    writeFileSync(file, Array.from({ length: 20 }, (_, i) => `match-${i}`).join("\n"), "utf8");
    const result = await call("grep", { path: file, pattern: "match" }, { limits: { maxMatchLines: 3 } });
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect((result.matches as unknown[]).length).toBe(3);
  });

  test("find 条目上限：递归结果被截断并标记", async () => {
    for (let i = 0; i < 6; i += 1) writeFileSync(join(root, `entry-${i}.txt`), "x", "utf8");
    const result = await call("find", { path: root, pattern: "entry" }, { limits: { maxEntries: 2 } });
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect((result.paths as unknown[]).length).toBeLessThanOrEqual(2);
  });

  test("find 深度上限：更深目录不被访问并标记截断", async () => {
    const deep = join(root, "l1", "l2", "l3");
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "deep.txt"), "x", "utf8");
    const result = await call("find", { path: root, pattern: "deep.txt" }, { limits: { maxDepth: 0 } });
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.paths).not.toContain(join(deep, "deep.txt"));
  });

  test("find 运行时间上限：now 注入推进时间后立即截断", async () => {
    for (let i = 0; i < 4; i += 1) writeFileSync(join(root, `timed-${i}.txt`), "x", "utf8");
    let tick = 0;
    const result = await call(
      "find",
      { path: root, pattern: "timed" },
      { limits: { maxRuntimeMs: 1 }, now: () => (tick += 10) }
    );
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
  });

  test("onLimit=fail：超限失败而不是静默截断", async () => {
    const file = join(root, "fail.txt");
    writeFileSync(file, "0123456789ABCDEF", "utf8");
    const result = await call(
      "read",
      { path: file },
      { limits: { maxReadBytes: 4, onLimit: "fail" } }
    );
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("RESOURCE_LIMIT_EXCEEDED");
  });
});

describe("T-12 builtin shell 结构化入口", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "zeta-t12-builtin-shell-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("bash/powershell 只经 structured.shell.start，不调用 backend.run 的 flag/command 形式", async () => {
    const legacyCalls: string[][] = [];
    const legacy = {
      name: "active-legacy",
      capabilities: () => ACTIVE,
      run: async (command: { argv: readonly string[] }) => {
        legacyCalls.push([...command.argv]);
        return { exitCode: 0, stdout: "", stderr: "", isolated: null };
      },
      dispose: () => {},
    };
    const spawned: string[][] = [];
    const spawnImpl: SpawnImpl = (_argv, _options, sink) => {
      spawned.push([..._argv]);
      sink("stdout", "shell-ok");
      return {
        pid: 77,
        cancel: async () => {},
        exited: Promise.resolve(0),
      };
    };
    const structured = createLocalSafeBackend({
      allowedDirectories: [root],
      spawn: spawnImpl,
      operations: { "shell.start": "active" },
    });
    const definitions = builtinToolDefinitions({
      securityBackend: legacy,
      structuredBackend: structured,
      allowedDirectories: [root],
    });

    const bash = definitions.find((item) => item.name === "bash")!;
    const result = (await bash.execute({ command: "echo hi" })) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("shell-ok");
    expect(spawned[0]).toEqual(["bash", "-c", "echo hi"]);
    expect(legacyCalls.length).toBe(0);
    expect(legacyCalls.some((argv) => argv[0] === "-c" || argv[0] === "-Command")).toBe(false);

    const powershell = definitions.find((item) => item.name === "powershell")!;
    const psResult = (await powershell.execute({ command: "Write-Output hi" })) as Record<string, unknown>;
    expect(psResult.ok).toBe(true);
    expect(spawned[1]).toEqual(["powershell", "-Command", "Write-Output hi"]);
    expect(legacyCalls.length).toBe(0);
  });

  test("structured shell 返回 termination=unknown 时工具进入对账而不是普通重试", async () => {
    const legacy = {
      name: "active-legacy",
      capabilities: () => ACTIVE,
      run: async () => ({ exitCode: 0, stdout: "", stderr: "", isolated: null }),
      dispose: () => {},
    };
    const shell = {
      start: async () => ({
        ok: true as const,
        value: {
          pid: 1,
          cancel: async () => {},
          exited: Promise.resolve({
            exitCode: -1,
            stdout: "",
            stderr: "",
            terminated: true,
            truncated: false,
            termination: "unknown" as const,
            reconciliation: "SHELL_TERMINATION_UNKNOWN:timeout;DO_NOT_RETRY",
          }),
        },
        evidence: { backend: "fake", operation: "shell.start" as const, at: 0, ok: true },
      }),
    };
    const definitions = builtinToolDefinitions({
      securityBackend: legacy,
      structuredBackend: {
        ...createStructuredRecordingBackend({ allowedDirectories: [root] }),
        shell,
      },
      allowedDirectories: [root],
    });
    const bash = definitions.find((item) => item.name === "bash")!;
    const result = (await bash.execute({ command: "echo hi" })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("SHELL_TERMINATION_UNKNOWN");
    expect(String(result.reconciliation)).toContain("DO_NOT_RETRY");
  });
});
