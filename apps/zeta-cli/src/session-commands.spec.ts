import { describe, expect, test } from "bun:test";
import type { RuntimeProtocol } from "@zeta-agent/agent";
import { runCompactCommand } from "./session-commands";

function protocol(control: RuntimeProtocol["sessionControl"]): RuntimeProtocol {
  return {
    session: { id: "cli-session", messages: () => [], reset: () => {} },
    control: { dispatch: async (frame) => ({ type: "control.result", ok: true, action: frame.action }) },
    event: { subscribe: () => () => {} },
    ...(control === undefined ? {} : { sessionControl: control }),
    dispatch: async (frame) => ({ type: "control.result", ok: true, action: frame.action }),
  };
}

describe("T-25 CLI /compact 生产接线", () => {
  test("无持久控制面时明确不执行，不伪装成功", async () => {
    const notices: string[] = [];
    const ok = await runCompactCommand(protocol(undefined), (text) => { notices.push(text); });

    expect(ok).toBe(false);
    expect(notices.join("\n")).toContain("需要持久会话控制面");
    expect(notices.join("\n")).not.toContain("已写入");
  });

  test("有持久控制面时调用真实 compact 并报告 frame 与 workspace 块", async () => {
    const calls: Array<string | undefined> = [];
    const notices: string[] = [];
    const control = {
      load: async () => ({ sessionId: "cli-session", messages: [], leafId: null, lineageCount: 0 }),
      fork: async () => ({ sessionId: "fork", from: null, frameId: null }),
      resume: async () => ({ sessionId: "resume", frameId: "f1" }),
      compact: async (sessionId?: string) => {
        calls.push(sessionId);
        return { sessionId: sessionId ?? "cli-session", compacted: true, uris: ["workspace:///a", "workspace:///b"], frameId: "f-compact" };
      },
    };
    const ok = await runCompactCommand(protocol(control), (text) => { notices.push(text); });

    expect(ok).toBe(true);
    expect(calls).toEqual(["cli-session"]);
    expect(notices.join("\n")).toContain("frame=f-compact");
    expect(notices.join("\n")).toContain("workspace 块=2");
  });

  test("控制面抛错时失败关闭并返回 false", async () => {
    const notices: string[] = [];
    const control = {
      load: async () => ({ sessionId: "cli-session", messages: [], leafId: null, lineageCount: 0 }),
      fork: async () => ({ sessionId: "fork", from: null, frameId: null }),
      resume: async () => ({ sessionId: "resume", frameId: "f1" }),
      compact: async () => { throw new Error("STORE_UNAVAILABLE"); },
    };
    const ok = await runCompactCommand(protocol(control), (text) => { notices.push(text); });

    expect(ok).toBe(false);
    expect(notices.join("\n")).toContain("STORE_UNAVAILABLE");
  });
});
