import { describe, expect, test } from "bun:test";
import {
  assertNoResidue,
  assertQuiescent,
  createTestContext,
  detectDependencyCycles,
  faultInject,
  observeDispose,
  replayConfig,
  type Disposable,
  type FiberSnapshot,
  type TeardownPosition,
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

describe("faultInject", () => {
  test("默认在首次调用注入故障，之后透传原函数", () => {
    const original = (value: number) => value * 2;
    const injected = faultInject(original, { error: new Error("boom") });
    expect(() => injected(1)).toThrow("boom");
    expect(injected(2)).toBe(4);
  });

  test("onCall 指定序号，when 条件优先", () => {
    const injected = faultInject((value: number) => value + 1, {
      onCall: 2,
      error: "third-call",
    });
    expect(injected(1)).toBe(2);
    expect(injected(2)).toBe(3);
    expect(() => injected(3)).toThrow("third-call");

    const conditional = faultInject((value: number) => value, {
      when: (_index, args) => args[0] === 9,
      error: "nine",
    });
    expect(conditional(1)).toBe(1);
    expect(() => conditional(9)).toThrow("nine");
  });
});

describe("createTestContext", () => {
  test("提供 fibers/effects/snapshot 观察面且可变更", async () => {
    const ctx = createTestContext({
      fibers: [{ uid: "f", state: { kind: "PENDING" } }],
      snapshot: { store: 1 },
    });
    expect(ctx.fibers()).toHaveLength(1);
    await assertQuiescent(ctx, 20);
    ctx.setFibers([{ uid: "f", state: { kind: "DISPOSED" } }]);
    await assertQuiescent(ctx, 20);
    ctx.setSnapshot({ store: 2 });
    expect(ctx.snapshot()).toEqual({ store: 2 });
    const disposable = effect("e", "k", 1);
    ctx.addEffect(disposable);
    expect(ctx.effects()).toEqual([disposable]);
    ctx.setEffects([]);
    expect(ctx.effects()).toEqual([]);
  });

  test("与 assertNoResidue 联用验证无残留", () => {
    const ctx = createTestContext({ snapshot: { store: "baseline" } });
    ctx.addEffect(effect("e", "k", 1));
    expect(() => assertNoResidue(ctx, { store: "baseline" })).not.toThrow();
  });
});

describe("detectDependencyCycles", () => {
  test("有向无环图不报环", () => {
    expect(
      detectDependencyCycles({ a: ["b"], b: ["c"], c: [] })
    ).toEqual([]);
  });

  test("发现环并返回首尾同节点的路径", () => {
    const cycles = detectDependencyCycles({ a: ["b"], b: ["c"], c: ["a"] });
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toEqual(["a", "b", "c", "a"]);
  });
});

function positionedEffect(
  uid: string,
  position: TeardownPosition
): Disposable {
  return { uid, key: `key-${uid}`, inverseCalls: 1, dispose: () => {}, teardown: position };
}

describe("assertNoResidue teardown 嵌套位置", () => {
  test("深度正确且同作用域 LIFO 时通过", () => {
    const ctx = createTestContext({
      snapshot: { store: "baseline" },
      effects: [
        positionedEffect("outer", { yieldDepth: 1, acquiredDepth: 1, scopeId: "s", acquireOrder: 0, teardownOrder: 1 }),
        positionedEffect("inner", { yieldDepth: 2, acquiredDepth: 2, scopeId: "s", acquireOrder: 1, teardownOrder: 0 }),
      ],
    });
    expect(() => assertNoResidue(ctx, { store: "baseline" })).not.toThrow();
  });

  test("teardown 位于错误嵌套深度时失败（次数正确也拒绝）", () => {
    const ctx = createTestContext({
      snapshot: { store: "baseline" },
      effects: [
        positionedEffect("e", { yieldDepth: 1, acquiredDepth: 3, scopeId: "s", acquireOrder: 0, teardownOrder: 0 }),
      ],
    });
    let message = "";
    try {
      assertNoResidue(ctx, { store: "baseline" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("嵌套位置错误");
    expect(message).toContain("e");
  });

  test("同作用域 teardown 非 LIFO 时失败", () => {
    const ctx = createTestContext({
      snapshot: { store: "baseline" },
      effects: [
        positionedEffect("a", { yieldDepth: 1, acquiredDepth: 1, scopeId: "s", acquireOrder: 0, teardownOrder: 0 }),
        positionedEffect("b", { yieldDepth: 1, acquiredDepth: 1, scopeId: "s", acquireOrder: 1, teardownOrder: 1 }),
      ],
    });
    let message = "";
    try {
      assertNoResidue(ctx, { store: "baseline" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("非 LIFO");
  });
});
