import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildShellEnv,
  createLocalSafeBackend,
  enforceOutputLimit,
} from "./backend.local-safe";
import {
  assertShellEgress,
  assertWorkspaceConfined,
  createStructuredExecutionBackend,
  operationState,
  type ProcessHandle,
  type StructuredShellBackend,
} from "./backend";
import { createEgressPolicy, type EgressTarget } from "./egress";

/** T-09：shell 的 env deny、fake credential、workspace confine、输出上限与 egress。 */
describe("T-09 shell 控制面", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "zeta-shell-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("env deny 移除敏感键，fake credential 注入占位值", () => {
    const env = buildShellEnv(
      {
        PATH: "usr/bin",
        AWS_SECRET_ACCESS_KEY: "real-secret",
        GITHUB_TOKEN: "ghp-real",
        KEEP_ME: "yes",
      },
      {
        denyEnv: ["AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN"],
        fakeCredentials: { AWS_SECRET_ACCESS_KEY: "FAKE" },
      }
    );
    expect(env.PATH).toBe("usr/bin");
    expect(env.KEEP_ME).toBe("yes");
    expect(env.AWS_SECRET_ACCESS_KEY).toBe("FAKE");
    expect("GITHUB_TOKEN" in env).toBe(false);
  });

  test("默认敏感键即使未显式 deny 也被剥离", () => {
    const env = buildShellEnv({ AWS_SECRET_ACCESS_KEY: "real", NORMAL: "ok" });
    expect("AWS_SECRET_ACCESS_KEY" in env).toBe(false);
    expect(env.NORMAL).toBe("ok");
  });

  test("workspace confine 拒绝 cwd 越界并接受根内路径", () => {
    expect(() => assertWorkspaceConfined(join(root, "sub"), [root])).not.toThrow();
    expect(() => assertWorkspaceConfined(join(root, "..", "outside"), [root])).toThrow(/CONFINEMENT/);
  });

  test("输出上限截断并标记 terminated", () => {
    const limited = enforceOutputLimit("abcdefghij", 4);
    expect(limited.truncated).toBe(true);
    expect(limited.stdout.length).toBeLessThanOrEqual(4);
  });

  test("egress 默认拒绝：无 allow 规则的目标被挡下", () => {
    const policy = createEgressPolicy();
    const target: EgressTarget = { host: "sink.test", port: 443 };
    expect(() =>
      assertShellEgress(policy, target)
    ).toThrow(/EGRESS_DENIED/);
  });

  test("egress 绑定：显式 allow 的目标放行", () => {
    const policy = createEgressPolicy({ allow: [{ host: "api.test", port: 443 }] });
    expect(() =>
      assertShellEgress(policy, { host: "api.test", port: 443 })
    ).not.toThrow();
  });

  test("local-safe 不把宿主进程执行包装成 active：shell.start 失败关闭", async () => {
    const backend = createLocalSafeBackend({ allowedDirectories: [root] });
    expect(operationState(backend.operations, "shell.start")).toBe("unsupported");
    const result = await backend.shell.start({ argv: ["echo", "hi"], cwd: root });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("OPERATION_UNAVAILABLE");
    await expect(backend.run({ argv: ["echo", "hi"] })).rejects.toThrow(/CRITICAL_LAYER_DEGRADED/);
  });

  test("结构化 shell 接口支持进程树取消契约", async () => {
    let cancelled = 0;
    const shell: StructuredShellBackend = {
      start: async () => {
        const handle: ProcessHandle = {
          pid: 4242,
          exited: Promise.resolve({ exitCode: -1, stdout: "", stderr: "", terminated: true, truncated: false }),
          cancel: async () => {
            cancelled += 1;
          },
        };
        return {
          ok: true,
          value: handle,
          evidence: { backend: "fake-shell", operation: "shell.start", at: 0, ok: true },
        };
      },
    };
    const backend = createStructuredExecutionBackend({
      name: "fake-shell",
      capabilities: {
        isolation: "active",
        seccomp: "active",
        fsConfinement: "active",
        auditSink: "active",
        egressDefaultDeny: "active",
      },
      executor: () => ({ exitCode: 0, stdout: "", stderr: "", isolated: null }),
      operations: { operations: { "shell.start": "active" } },
      shell,
    });
    const result = await backend.shell.start({ argv: ["sleep", "10"], cwd: root });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.pid).toBe(4242);
      await result.value.cancel();
    }
    expect(cancelled).toBe(1);
  });
});
