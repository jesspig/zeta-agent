import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuditSink } from "@zeta-agent/security";
import { createDurableEffects } from "../plugins/effects/durable";
import { createDefaultRuntime } from "./runtime";

const dirs: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "zeta-runtime-security-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("T-25 默认 runtime 安全边界注入", () => {
  test("显式 durableEffects 与 auditSink 进入真实工具生产路径", async () => {
    const root = tempRoot();
    const dispatched: string[] = [];
    const durableEffects = createDurableEffects(async (intent) => {
      dispatched.push(intent.key);
      return "dispatched";
    });
    const auditSink = createAuditSink();
    let streams = 0;
    const runtime = await createDefaultRuntime({
      profile: "local-full",
      includeBuiltins: false,
      allowedDirectories: [root],
      agentRoot: join(root, "agent"),
      sessionStorePath: join(root, "session.jsonl"),
      durableEffects,
      auditSink,
      streamFn: async function* () {
        streams += 1;
        if (streams === 1) yield { type: "tool_call", id: "emit-1", name: "emit", arguments: "{}" };
        else yield "done";
      },
    });
    runtime.agent.registerTool({
      name: "emit",
      execute: async () => ({ ok: true }),
    });
    runtime.agent.declareEmissionTools(["emit"]);

    await runtime.agent.prompt("run");

    expect(dispatched).toHaveLength(1);
    expect(auditSink.entries.some((entry) => entry.record.toolName === "emit")).toBe(true);
    await runtime.dispose();
  });
});
