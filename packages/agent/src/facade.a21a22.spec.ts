import { describe, expect, test } from "bun:test";
import type { Capabilities } from "@zeta-agent/agent-framework";
import { createAgent } from "./facade";

function activeCapabilities(): Capabilities {
  return {
    isolation: "active",
    seccomp: "active",
    fsConfinement: "active",
    auditSink: "active",
    egressDefaultDeny: "active",
  };
}

describe("T-10 A21/A22 在 facade 层可执行", () => {
  test("A21 OTLP 配置失败降级 file：经 createAgent 暴露的 resolveLogSink 可达", () => {
    const fileWrites: string[] = [];
    const invalid = createAgent().resolveLogSink({
      endpoint: "not-a-url",
      exporter: { export: () => {} },
      file: { write: (message) => fileWrites.push(message.message) },
    });

    expect(invalid.mode).toBe("file");
    invalid.sink({
      fiberUid: "f",
      runId: "r",
      level: "info",
      message: "event",
    });
    expect(fileWrites).toHaveLength(1);
  });

  test("A21 脱敏生效：经 createAgent 的 addRedactor 在 sink 前生效", async () => {
    const emitted: string[] = [];
    const agent = createAgent({
      observability: { runId: "run-a21", sink: (message) => emitted.push(message.message) },
      streamFn: async function* () {
        yield "token sk-secret123 present";
      },
    });
    const stop = agent.addRedactor({ match: /sk-[A-Za-z0-9]+/g, replace: "[REDACTED]" });

    await agent.prompt("hello");
    await agent.waitForIdle();

    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted.some((message) => message.includes("[REDACTED]"))).toBe(true);
    expect(emitted.every((message) => !message.includes("sk-secret123"))).toBe(true);

    stop();
  });

  test("A22 critical layer degraded 时工具 FAILED：经 createAgent 的 runTool 表面", async () => {
    const capabilities = activeCapabilities();
    capabilities.seccomp = "degraded";
    const backend = {
      name: "degraded-backend",
      capabilities: () => ({ ...capabilities }),
      run: async () => ({ exitCode: 0, stdout: "", stderr: "", isolated: null }),
      dispose: () => {},
    };

    const agent = createAgent({ securityBackend: backend });
    let executed = false;
    const result = await agent.runTool({
      name: "bash",
      execute: () => {
        executed = true;
        return "should not run";
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("CRITICAL_LAYER_DEGRADED");
    expect(executed).toBe(false);
    expect(agent.capabilities().seccomp).toBe("degraded");
  });

  test("A22 关键层 active 时工具成功经 runTool 执行", async () => {
    const backend = {
      name: "active-backend",
      capabilities: () => activeCapabilities(),
      run: async () => ({ exitCode: 0, stdout: "", stderr: "", isolated: null }),
      dispose: () => {},
    };
    const agent = createAgent({ securityBackend: backend });

    const result = await agent.runTool({
      name: "read",
      execute: () => "file-content",
    });

    expect(result).toEqual({ ok: true, value: "file-content" });
  });
});
