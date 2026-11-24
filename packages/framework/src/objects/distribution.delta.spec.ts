import { describe, expect, test } from "bun:test";
import {
  adopt,
  applyImmutable,
  baseline,
  hashValue,
  prepare,
  StaleDeltaError,
  track,
  type Delta,
} from "./index";

describe("T-19/delta: 权威基线与 stale 拒绝", () => {
  test("按权威 seq 应用；fingerprint/seq/generation 不符一律 STALE", () => {
    const base = { a: 1, b: { c: 2 } };
    let current = baseline(base, { generation: 7 });
    expect(current.seq).toBe(0);
    expect(current.fingerprint).toBe(hashValue(base));

    const t1 = track(current.value);
    t1.set(["a"], 5);
    const d1 = adopt(prepare(t1), 7);
    current = current.apply(d1, 7);
    expect(current.value).toEqual({ a: 5, b: { c: 2 } });
    expect(current.seq).toBe(d1.seq);

    const t2 = track(current.value);
    t2.set(["b", "c"], 9);
    const d2 = adopt(prepare(t2), 7);

    expect(() => baseline({ a: 1, b: { c: 2 } }, { generation: 7 }).apply(d2, 7)).toThrow(StaleDeltaError);
    expect(() => current.apply(d1, 7)).toThrow(StaleDeltaError); // seq 回退
    expect(() => current.apply(d2, 8)).toThrow(StaleDeltaError); // 代次串了
    try {
      current.apply(d1, 7);
    } catch (error) {
      expect((error as StaleDeltaError).reason).toBe("SEQ");
    }
    current = current.apply(d2, 7);
    expect(current.value).toEqual({ a: 5, b: { c: 9 } });
  });

  test("adopt 给 delta 打上 generation；同指纹 pending 互相 stale", () => {
    const tracker = track({ x: 1 });
    tracker.set(["x"], 2);
    const first = prepare(tracker);
    const second = prepare(tracker);
    const delta: Delta = adopt(first, 3);
    expect(delta.generation).toBe(3);
    expect(first.stale).toBe(false);
    expect(second.stale).toBe(true);
  });

  test("深不可变：结果不与输入/ops 共享可变对象，op 与 delta 冻结", () => {
    const base = { nested: { list: [{ v: 1 }] } };
    const tracker = track(base);
    tracker.set(["nested", "list", 0], { v: 2 });
    const delta = adopt(prepare(tracker));
    expect(Object.isFrozen(delta)).toBe(true);
    expect(Object.isFrozen(delta.ops)).toBe(true);
    for (const op of delta.ops) expect(Object.isFrozen(op)).toBe(true);

    const next = applyImmutable(base, delta) as { nested: { list: Array<{ v: number }> } };
    expect(next).toEqual({ nested: { list: [{ v: 2 }] } });
    expect(next.nested).not.toBe(base.nested);
    expect(next.nested.list).not.toBe(base.nested.list);
    expect(next.nested.list[0]).not.toBe((base.nested.list as Array<{ v: number }>)[0]);
    next.nested.list[0]!.v = 99;
    expect(base.nested.list[0]!.v).toBe(1);
    const opValue = (delta.ops[0] as readonly ["s", readonly (string | number)[], unknown])[2] as { v: number };
    expect(opValue.v).toBe(2);
  });
});
