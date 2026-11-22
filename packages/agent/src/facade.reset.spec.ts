import { describe, expect, test } from "bun:test";
import { createAgent } from "./facade";

/** CR-04：reset 后下一轮请求不得携带旧会话消息。 */
describe("T-04 会话上下文重置", () => {
  test("reset 清空 messages，下一轮请求不含旧消息", async () => {
    const requests: Array<readonly { role: string }[]> = [];
    const agent = createAgent({
      streamFn: async function* (request) {
        requests.push(request.messages as readonly { role: string }[]);
        yield "ok";
      },
    });

    await agent.prompt("第一句");
    expect(agent.state.messages.length).toBeGreaterThan(0);

    agent.reset();
    expect(agent.state.messages).toHaveLength(0);

    await agent.prompt("第二句");
    const last = requests.at(-1) ?? [];
    const userTexts = last.filter((m) => m.role === "user");
    expect(userTexts).toHaveLength(1);
    expect(agent.state.messages.filter((m) => m.role === "user")).toHaveLength(1);
  });

  test("reset 保留事件订阅者", async () => {
    const agent = createAgent({ streamFn: async function* () { yield "x"; } });
    let events = 0;
    agent.subscribe(() => { events += 1; });
    await agent.prompt("a");
    const before = events;
    expect(before).toBeGreaterThan(0);
    agent.reset();
    await agent.prompt("b");
    expect(events).toBeGreaterThan(before);
  });
});
