import { describe, expect, test } from "bun:test";
import {
  createFollowUpQueue,
  drainQueue,
  enqueueFollowUp,
  resolveSubmitMode,
} from "./components/editor";

describe("T-08 编辑器语义", () => {
  test("resolveSubmitMode：Enter=steer、Alt+Enter=follow-up", () => {
    expect(resolveSubmitMode({ name: "return" })).toBe("steer");
    expect(resolveSubmitMode({ name: "return", meta: true })).toBe("follow-up");
    expect(resolveSubmitMode({ name: "return", option: true })).toBe("follow-up");
    expect(resolveSubmitMode({ name: "return", shift: true })).toBe(null);
    expect(resolveSubmitMode({ name: "a" })).toBe(null);
  });

  test("follow-up 队列：入队后 Alt+Up 取回（FIFO），abort 时整队退回编辑器", () => {
    const queue = createFollowUpQueue();
    queue.enqueue("first");
    queue.enqueue("second");
    expect(queue.size()).toBe(2);
    expect(queue.take()).toBe("first");
    expect(queue.take()).toBe("second");
    expect(queue.take()).toBe(undefined);

    queue.enqueue("queued-a");
    queue.enqueue("queued-b");
    expect(drainQueue(queue)).toEqual(["queued-a", "queued-b"]);
    expect(queue.size()).toBe(0);
  });

  test("enqueueFollowUp 生成稳定 id 的条目", () => {
    const entry = enqueueFollowUp("hello", 7);
    expect(entry).toEqual({ id: 7, text: "hello" });
  });
});
