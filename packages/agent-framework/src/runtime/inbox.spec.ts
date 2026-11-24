import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "./agent";
import { createInbox } from "./inbox";

function msg(content: string): AgentMessage {
  return { role: "user", content };
}

function contents(messages: readonly { body: AgentMessage }[]): unknown[] {
  return messages.map((item) => item.body.content);
}

describe("T-14 inbox 双队列与 QueueMode", () => {
  test("inject 只写 nextStep 且按 FIFO 顺序被 claim", () => {
    const inbox = createInbox();
    const first = inbox.inject(msg("a"));
    const second = inbox.inject(msg("b"));
    expect(inbox.size("nextStep")).toBe(2);
    expect(inbox.size("nextTurn")).toBe(0);
    expect(inbox.claim("nextStep")?.id).toBe(first.id);
    expect(inbox.claim("nextStep")?.id).toBe(second.id);
    expect(inbox.claim("nextStep")).toBeUndefined();
    expect(second.id).toBeGreaterThan(first.id);
  });

  test("followUp 追加到独立队列且 poll 后清空", () => {
    const inbox = createInbox();
    inbox.followUp(msg("f1"));
    inbox.followUp(msg("f2"));
    expect(inbox.size("nextTurn")).toBe(0);
    expect(contents(inbox.poll("followUp"))).toEqual(["f1", "f2"]);
    expect(inbox.size("followUp")).toBe(0);
  });

  test("QueueMode all：steer 的消息全部进入 nextTurn", () => {
    const inbox = createInbox({ mode: "all" });
    inbox.steer(msg("s1"));
    inbox.steer(msg("s2"));
    inbox.steer(msg("s3"));
    expect(contents(inbox.poll("nextTurn"))).toEqual(["s1", "s2", "s3"]);
  });

  test("QueueMode step：每次 poll 仅消费一条", () => {
    const inbox = createInbox({ mode: "step" });
    inbox.steer(msg("s1"));
    inbox.steer(msg("s2"));
    inbox.steer(msg("s3"));
    expect(contents(inbox.poll("nextTurn"))).toEqual(["s1"]);
    expect(contents(inbox.poll("nextTurn"))).toEqual(["s2"]);
    expect(contents(inbox.poll("nextTurn"))).toEqual(["s3"]);
    expect(inbox.poll("nextTurn")).toHaveLength(0);
  });

  test("QueueMode interrupt：清空 nextStep 并让新消息占据 nextTurn 队首", () => {
    const inbox = createInbox({ mode: "all" });
    inbox.inject(msg("old-step"));
    inbox.setMode("interrupt");
    inbox.steer(msg("urgent"));
    expect(inbox.size("nextStep")).toBe(0);
    expect(inbox.peek("nextTurn")?.body.content).toBe("urgent");
    expect(inbox.getMode()).toBe("interrupt");
  });
});
