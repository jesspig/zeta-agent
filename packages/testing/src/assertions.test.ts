import { describe, expect, test } from "bun:test";
import {
  assertNoResidue,
  assertQuiescent,
  observeDispose,
  replayConfig,
  type Disposable,
  type FiberSnapshot,
} from "./assertions";

function contextWith(states: string[]): { fibers(): readonly FiberSnapshot[] } {
  let index = 0;
  return {
    fibers: () => {
      const current = states[Math.min(index, states.length - 1)]!;
      index += 1;
      return [{ uid: "fiber-1", state: { kind: current } }];
    },
  };
}

function effect(uid: string, key: string, inverseCalls: number): Disposable {
  return { uid, key, inverseCalls, dispose: () => {} };
}

describe("assertQuiescent", () => {
  test("等待 fiber 到 settled 状态", async () => {
    await assertQuiescent(contextWith(["LOADING", "ACTIVE"]), 100);
  });

  test("fiber 未静止时超时失败并含 uid", async () => {
    let message = "";
    try {
      await assertQuiescent(contextWith(["LOADING"]), 20);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("fiber-1");
    expect(message).toContain("LOADING");
  });
});

describe("assertNoResidue", () => {
  test("逆调用一次且快照回到基线时通过", () => {
    const snapshot = { store: 1 };
    assertNoResidue(
      { effects: () => [effect("fiber-1", "key-a", 1)], snapshot: () => ({ store: 1 }) },
      snapshot
    );
  });

  test("逆重复调用时失败并含 uid 与键名", () => {
    let message = "";
    try {
      assertNoResidue(
        { effects: () => [effect("fiber-9", "key-b", 2)], snapshot: () => ({ store: 1 }) },
        { store: 1 }
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("fiber-9");
    expect(message).toContain("key-b");
  });
});

describe("replayConfig", () => {
  const build = (sequence: readonly string[]) => {
    const result: Record<string, number> = {};
    for (const item of sequence) result[item] = 1;
    return result;
  };

  test("同配置不同顺序得到相同观察状态", () => {
    const state = replayConfig(
      [["a", "b"], ["b", "a"]],
      build
    );
    expect(state).toEqual({ a: 1, b: 1 });
  });

  test("观察状态不同时失败", () => {
    expect(() => replayConfig([["a"], ["b"]], build)).toThrow("汇合失败");
  });
});

describe("observeDispose", () => {
  const effects = [effect("f1", "k1", 1), effect("f2", "k2", 1), effect("f3", "k3", 1)];

  test("逆按 LIFO 执行时通过", () => {
    const order = observeDispose(effects, (all) =>
      [...all].reverse().map((item) => item.uid)
    );
    expect(order).toEqual(["f3", "f2", "f1"]);
  });

  test("逆顺序错误时失败并含 uid 序列", () => {
    let message = "";
    try {
      observeDispose(effects, (all) => all.map((item) => item.uid));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("f1,f2,f3");
  });
});
