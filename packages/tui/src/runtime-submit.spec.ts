import { expect, test } from "bun:test";
import { createTuiSubmitHandler } from "./runtime";

test("旧同步 void 回调执行后视为接受", () => {
  let calls = 0;
  const submit = createTuiSubmitHandler({ onSubmit: () => { calls += 1; } });
  expect(submit("hello")).toBe(true);
  expect(calls).toBe(1);
});

test("异步 void 回调完成前不视为拒绝", async () => {
  const submit = createTuiSubmitHandler({ onSubmit: async () => {} });
  expect(await submit("hello")).toBeUndefined();
});

test("显式 false 与缺失处理器均视为拒绝", () => {
  expect(createTuiSubmitHandler({ onSubmit: () => false })("hello")).toBe(false);
  expect(createTuiSubmitHandler({})("hello")).toBe(false);
});
