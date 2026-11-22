import { describe, expect, test } from "bun:test";
import { createConnectionSequence, selectModelAfterConnect } from "./index";

/** CR-05：连接后必须得到属于新端点列表的有效模型，不能是空串。 */
describe("T-05 连接后的模型选择", () => {
  test("未连接状态（echo）首次连接采用首个模型", () => {
    expect(selectModelAfterConnect("echo", ["m1", "m2"])).toBe("m1");
  });

  test("旧模型不在新列表时改用首个模型", () => {
    expect(selectModelAfterConnect("old-model", ["m1", "m2"])).toBe("m1");
  });

  test("旧模型仍在新列表时保留用户选择", () => {
    expect(selectModelAfterConnect("m2", ["m1", "m2"])).toBe("m2");
  });

  test("空模型列表时不应产生空串模型（返回 undefined 交由上层阻断发送）", () => {
    expect(selectModelAfterConnect("echo", [])).toBeUndefined();
  });
});

/** CR-06：迟到的连接结果不得覆盖更新的连接。 */
describe("T-06 连接代次控制", () => {
  test("较早的代次在更新发起后变为过期", () => {
    const seq = createConnectionSequence();
    const g1 = seq.next();
    expect(seq.isCurrent(g1)).toBe(true);
    const g2 = seq.next();
    expect(seq.isCurrent(g1)).toBe(false);
    expect(seq.isCurrent(g2)).toBe(true);
  });
});
