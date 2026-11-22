import { describe, expect, test } from "bun:test";
import { createInbox } from "./inbox";
import { runLoop, type LoopRuntime } from "./loop";
import { createEventStream } from "./agent";

/** CR-16：运行中入队的 steering 消息必须进入下一轮请求，不能被 continue 分支吞掉。 */
describe("T-15 续跑队列不被提前消费", () => {
  test("continue 分支不 poll，下一轮能拿到运行中入队的消息", async () => {
    const inbox = createInbox();
    const requests: Array<readonly { role: string; content: unknown }[]> = [];
    let streamCount = 0;
    const stream = createEventStream();
    const runtime: LoopRuntime = {
      inbox,
      emit: (e) => stream.emit(e),
      getState: () => stream.getState(),
      prepareRequest: (r) => r,
      streamAssistant: async (request) => {
        streamCount += 1;
        const base = (request as { messages?: readonly { role: string; content: unknown }[] }).messages ?? [];
        requests.push(base);
        if (streamCount === 1) {
          // 模拟运行中入队
          inbox.steer({ role: "user", content: "queued" });
          return {
            message: { role: "assistant", content: "r1" },
            toolCalls: [{ id: "c1", name: "t", args: {} }],
            stopReason: "stop" as const,
          };
        }
        return {
          message: { role: "assistant", content: "r2" },
          toolCalls: [],
          stopReason: "stop" as const,
        };
      },
      executeToolCalls: async () => [{ callId: "c1", message: { role: "toolResult", content: "ok" } }],
      finishTurn: (turn) => ({ action: streamCount < 2 ? "continue" : "end" } as const),
    };
    await runLoop(runtime);
    const lastRequest = requests.at(-1) ?? [];
    expect(lastRequest.some((m) => m.role === "user" && String(m.content).includes("queued"))).toBe(true);
  });
});
