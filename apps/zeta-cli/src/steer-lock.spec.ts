import { expect, test } from "bun:test";
import { createSteerRunner } from "./index";

test("初始 prompt 与后续 steer 共用同一运行锁", async () => {
  let release: (() => void) | undefined;
  let busy = 0;
  const runner = createSteerRunner({
    isBusy: () => false,
    prompt: () => new Promise<unknown>((resolve) => { release = () => resolve(undefined); }),
    waitForIdle: async () => {},
    onBusy: () => { busy += 1; },
    onError: () => {},
  });

  const initial = runner.start("initial");
  const second = runner.start("second");
  expect(initial.accepted).toBe(true);
  expect(second.accepted).toBe(false);
  expect(busy).toBe(1);

  release?.();
  await initial.done;
  expect(runner.start("third").accepted).toBe(true);
});

test("prompt 失败恢复草稿并释放运行锁", async () => {
  const restored: string[] = [];
  const runner = createSteerRunner({
    isBusy: () => false,
    prompt: async () => { throw new Error("provider failed"); },
    waitForIdle: async () => {},
    onBusy: () => {},
    onError: () => {},
    restoreDraft: (text) => restored.push(text),
  });

  const first = runner.start("draft");
  await first.done;
  expect(restored).toEqual(["draft"]);
  expect(runner.start("retry").accepted).toBe(true);
});
