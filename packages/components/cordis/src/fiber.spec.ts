import { describe, expect, test } from "bun:test";
import type { CoeffectKey } from "@zeta-agent/framework";
import { NOOP } from "./effect";
import { FiberSystem, key, type FiberSpec } from "./fiber";

const dep = key("dep");
const svc = key("svc");

function spec(overrides: Partial<FiberSpec> & { uid: string }): FiberSpec {
  return { inject: [], provide: [], ...overrides };
}

describe("Fiber 六态状态机", () => {
  test("初始状态为 PENDING", () => {
    const system = new FiberSystem();
    const fiber = system.create(spec({ uid: "f1" }));
    expect(fiber.state.kind).toBe("PENDING");
  });

  test("依赖齐备时 L-Begin 到 LOADING 再进入 ACTIVE", async () => {
    const system = new FiberSystem();
    const fiber = system.create(spec({ uid: "f2" }));
    const pending = fiber.refresh();
    expect(fiber.state.kind).toBe("LOADING");
    await pending;
    expect(fiber.state.kind).toBe("ACTIVE");
  });

  test("provider 撤回等待消费者去活（guard）后再回 PENDING", async () => {
    const system = new FiberSystem();
    const base = system.create(spec({ uid: "base", provide: [dep] }));
    const provider = system.create(spec({ uid: "provider", inject: [dep], provide: [svc] }));
    const consumer = system.create(spec({ uid: "consumer", inject: [svc] }));
    await base.refresh();
    await provider.refresh();
    await consumer.refresh();
    expect(provider.state.kind).toBe("ACTIVE");

    base.remove();
    const unloading = provider.refresh();
    expect(provider.state.kind).toBe("UNLOADING");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(provider.state.kind).toBe("UNLOADING");

    consumer.remove();
    await unloading;
    expect(provider.state.kind).toBe("PENDING");
  });

  test("FAILED 不自动重试，update 才恢复", async () => {
    const system = new FiberSystem();
    let fails = true;
    const fiber = system.create(
      spec({
        uid: "f4",
        apply: () => {
          if (fails) throw new Error("boom");
          return NOOP;
        },
      })
    );
    await fiber.refresh();
    expect(fiber.state.kind).toBe("FAILED");
    await fiber.refresh();
    expect(fiber.state.kind).toBe("FAILED");
    fails = false;
    await fiber.update();
    expect(fiber.state.kind).toBe("ACTIVE");
  });

  test("O-Remove 进入 DISPOSED 终态", async () => {
    const system = new FiberSystem();
    const fiber = system.create(spec({ uid: "f5" }));
    await fiber.refresh();
    fiber.remove();
    expect(fiber.state.kind).toBe("DISPOSED");
  });

  test("状态转移表覆盖全部六态且无 INACTIVE", () => {
    const kinds = ["PENDING", "LOADING", "ACTIVE", "UNLOADING", "FAILED", "DISPOSED"];
    expect(kinds).toHaveLength(6);
    expect(kinds).not.toContain("INACTIVE");
  });

  test("unload 回收 apply 内多次 ctx.effect 的全部逆（unloadHost）", async () => {
    // 审计项 D：apply 内多次 ctx.effect，卸载时所有逆须被统一回收。
    // 当前 unload 只 await state.dispose，多次 effect 中未被 yield 的逆残留 → RED。
    const system = new FiberSystem();
    const inverseOrder: number[] = [];
    const provider = system.create(spec({ uid: "provider", provide: [dep] }));
    const consumer = system.create(
      spec({
        uid: "consumer-multi-effect",
        inject: [dep],
        apply: (ctx) => {
          ctx.effect(() => () => {
            inverseOrder.push(1);
          });
          ctx.effect(() => () => {
            inverseOrder.push(2);
          });
          return NOOP;
        },
      })
    );
    await provider.refresh();
    await consumer.refresh();
    expect(consumer.state.kind).toBe("ACTIVE");

    // 撤回 provider 触发 consumer 卸载（进入 UNLOADING → unload()）。
    provider.remove();
    const unloading = consumer.refresh();
    expect(consumer.state.kind).toBe("UNLOADING");
    await unloading;
    expect(consumer.state.kind).toBe("PENDING");

    // 两个逆都应各调用一次；unloadHost 逆序 → 先 2 后 1
    expect(inverseOrder).toEqual([2, 1]);
  });
});
