import { describe, expect, test } from "bun:test";
import { createEventStream, createInitialState, type AgentEvent, type AgentMessage } from "./agent";
import {
  AGENT_DECISION_KINDS,
  createDecisionWaterfall,
  describeDecision,
  nextAction,
  type AgentDecision,
} from "./decision";
import { createInbox } from "./inbox";
import { runLoop } from "./loop";

const context = {
  state: createInitialState(),
  event: { type: "turn_start" } as AgentEvent,
};

describe("T-15 decision union 与 waterfall 拦截", () => {
  test("AgentDecision 恰好 3 个变体且可穷举渲染", () => {
    expect(AGENT_DECISION_KINDS).toEqual(["reasoning", "acting", "exit"]);
    const variants: AgentDecision[] = [
      { kind: "reasoning", note: "think" },
      { kind: "acting", toolCallIds: ["a", "b"] },
      { kind: "exit", reason: "done" },
    ];
    expect(variants.map(describeDecision)).toEqual([
      "reasoning:think",
      "acting:a,b",
      "exit:done",
    ]);
  });

  test("nextAction 是纯函数并覆盖三种决策", () => {
    const base = createInitialState({ messages: [{ role: "user", content: "hi" }] });
    expect(nextAction(base)).toEqual({ kind: "reasoning", note: "messages:1" });

    const acting = createInitialState({ pendingToolCalls: new Set(["b", "a"]) });
    expect(nextAction(acting)).toEqual({ kind: "acting", toolCallIds: ["a", "b"] });

    const exit = createInitialState({ errorMessage: "boom" });
    expect(nextAction(exit)).toEqual({ kind: "exit", reason: "boom" });

    expect(base.messages).toHaveLength(1);
  });

  test("waterfall 按注册顺序改写 decision 且 disposer 生效", async () => {
    const waterfall = createDecisionWaterfall();
    const order: string[] = [];
    const stopFirst = waterfall.add((decision, next) => {
      order.push("a");
      next({ kind: "reasoning", note: `${(decision as { note: string }).note}+a` });
    });
    waterfall.add((decision, next) => {
      order.push("b");
      const note = decision.kind === "reasoning" ? decision.note : "?";
      next({ kind: "reasoning", note: `${note}+b` });
    });

    const result = await waterfall.run({ kind: "reasoning", note: "base" }, context);
    expect(order).toEqual(["a", "b"]);
    expect(result).toEqual({ kind: "reasoning", note: "base+a+b" });
    expect(waterfall.size).toBe(2);

    stopFirst();
    expect(waterfall.size).toBe(1);
  });

  test("waterfall 可改写为 exit；重复 next() 抛错", async () => {
    const waterfall = createDecisionWaterfall();
    waterfall.add((_decision, next) => next({ kind: "exit", reason: "intercepted" }));
    const rewritten = await waterfall.run({ kind: "reasoning", note: "x" }, context);
    expect(rewritten).toEqual({ kind: "exit", reason: "intercepted" });

    const bad = createDecisionWaterfall();
    bad.add((_decision, next) => {
      next({ kind: "exit", reason: "1" });
      next({ kind: "exit", reason: "2" });
    });
    let message = "";
    try {
      await bad.run({ kind: "reasoning", note: "x" }, context);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("next() 重复调用");
  });

  test("waterfall 把 decision 改写为 exit 后 runLoop 不进入下一轮", async () => {
    const stream = createEventStream();
    const order: string[] = [];
    stream.subscribe((event) => {
      order.push(event.type);
    });
    const inbox = createInbox();
    const userMessage: AgentMessage = { role: "user", content: "q" };
    inbox.followUp(userMessage);

    const waterfall = createDecisionWaterfall();
    waterfall.add((_decision, next) => next({ kind: "exit", reason: "intercepted" }));

    let streamCount = 0;
    await runLoop({
      inbox,
      emit: (event) => stream.emit(event),
      getState: () => stream.getState(),
      decision: () => ({ kind: "reasoning", note: "keep-going" }),
      waterfall,
      streamAssistant: async () => {
        streamCount += 1;
        return { message: { role: "assistant", content: "ok" }, toolCalls: [], stopReason: "stop" };
      },
      executeToolCalls: async () => [],
    });

    expect(streamCount).toBe(1);
    expect(order.filter((type) => type === "turn_start")).toHaveLength(1);
    expect(order.at(-1)).toBe("agent_end");
  });
});
