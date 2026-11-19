import { describe, expect, test } from "bun:test";
import { createEffectHost, effect, execute, unloadHost } from "./effect";

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe("execute", () => {
  test("单个 effect 内逆按 LIFO 执行 [3,2,1]", async () => {
    const order: number[] = [];
    const host = createEffectHost("f-lifo");
    effect(host, function* () {
      yield () => {
        order.push(1);
      };
      yield () => {
        order.push(2);
      };
      yield () => {
        order.push(3);
      };
    });
    await settle();
    await host.dispose();
    expect(order).toEqual([3, 2, 1]);
  });

  test("fiber 级多 effect 逆序启动并并发执行 [3,2,1]", async () => {
    const order: number[] = [];
    const host = createEffectHost("f-fiber");
    effect(host, () => () => {
      order.push(1);
    });
    effect(host, () => () => {
      order.push(2);
    });
    effect(host, () => () => {
      order.push(3);
    });
    await settle();
    await unloadHost(host);
    expect(order).toEqual([3, 2, 1]);
  });

  test("二次 dispose 不重复执行逆", async () => {
    let calls = 0;
    const host = createEffectHost("f-once");
    const dispose = effect(host, () => () => {
      calls += 1;
    });
    await settle();
    await dispose();
    await dispose();
    expect(calls).toBe(1);
  });

  test("guard 为 false 时停止迭代且只回收已 yield 的逆", async () => {
    const order: number[] = [];
    let checks = 0;
    const recover = await execute(
      [
        () => {
          order.push(1);
        },
        () => {
          order.push(2);
        },
        () => {
          order.push(3);
        },
      ],
      () => ++checks <= 2
    );
    await recover();
    expect(order).toEqual([2, 1]);
    expect(checks).toBe(3);
  });

  test("exact disposer 身份：yield 底层 disposer 调用一次且顺序正确", async () => {
    const order: string[] = [];
    const inner = () => {
      order.push("inner");
    };
    const outer = () => {
      order.push("outer");
    };
    const inverse = await execute([inner, outer], () => true);
    await inverse();
    expect(order).toEqual(["outer", "inner"]);
    expect(order.filter((item) => item === "inner")).toHaveLength(1);
  });
});
