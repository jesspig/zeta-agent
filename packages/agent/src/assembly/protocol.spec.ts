import { describe, expect, test } from "bun:test";
import { MODES } from "../cli/modes";
import { createDefaultRuntime } from "./runtime";
import { createRuntimeProtocol, encodeControlFrame } from "./protocol";
import { createAgent } from "../facade";

function stubStream() {
  return async function* () {
    yield "ok";
    yield { type: "done", stopReason: "stop" } as const;
  };
}

function collector() {
  const lines: string[] = [];
  return { lines, output: (line: string) => lines.push(line) };
}

describe("T-10 四模式共享 session/control/event 协议", () => {
  test("control 帧驱动 prompt/steer/followUp/abort/reset，session 与 event 共享同一 agent", async () => {
    const agent = createAgent({ includeBuiltins: false, streamFn: stubStream() });
    const protocol = createRuntimeProtocol(agent, "session-test");
    const events: string[] = [];
    const stop = protocol.event.subscribe((event) => events.push(event.type));

    expect(protocol.session.id).toBe("session-test");
    const started = await protocol.control.dispatch({ type: "control", action: "prompt", text: "hello" });
    expect(started.ok).toBe(true);
    expect(started.action).toBe("prompt");
    expect(protocol.session.messages().some((m) => m.role === "user" && m.content === "hello")).toBe(true);
    expect(events).toContain("agent_start");

    protocol.control.dispatch({ type: "control", action: "steer", message: { role: "user", content: "steered" } });
    protocol.control.dispatch({ type: "control", action: "followUp", message: { role: "user", content: "later" } });
    const aborted = await protocol.control.dispatch({ type: "control", action: "abort" });
    expect(aborted.ok).toBe(true);
    expect(agent.aborted).toBe(true);

    const reset = await protocol.control.dispatch({ type: "control", action: "reset" });
    expect(reset.ok).toBe(true);
    expect(protocol.session.messages()).toEqual([]);
    stop();
  });

  test("encodeControlFrame 生成可解析的控制帧", () => {
    const frame = encodeControlFrame({ action: "prompt", text: "x" });
    expect(frame.type).toBe("control");
    expect(frame.action).toBe("prompt");
  });

  test("interactive/print/json/rpc 使用同一协议句柄，会话状态一致", async () => {
    for (const name of ["interactive", "print", "json", "rpc"] as const) {
      const runtime = await createDefaultRuntime({
        includeBuiltins: false,
        streamFn: stubStream(),
        profile: "local-safe",
      });
      const sink = collector();
      const code = await MODES[name].run(runtime.agent, {
        prompt: "hi",
        lines:
          name === "rpc"
            ? ['{"jsonrpc":"2.0","id":1,"method":"prompt","params":{"text":"hi"}}']
            : name === "interactive"
              ? ["hi"]
              : undefined,
        output: sink.output,
        protocol: runtime.protocol,
      });

      expect(code, name).toBe(0);
      expect(sink.lines.length, name).toBeGreaterThan(0);
      expect(
        runtime.protocol.session.messages().some((m) => m.role === "user" && m.content === "hi"),
        name
      ).toBe(true);
      expect(runtime.manifest.profile).toBe("local-safe");
      await runtime.dispose();
    }
  });
});
