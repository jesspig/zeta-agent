import { describe, expect, test } from "bun:test";
import type { CoeffectKey } from "./types";
import { NOOP } from "./effect";
import { FiberSystem, key, type Fiber, type FiberSpec } from "./fiber";

const dep = key("dep");
const svc = key("svc");

function spec(overrides: Partial<FiberSpec> & { uid: string }): FiberSpec {
  return { inject: [], provide: [], ...overrides };
}

describe("T-13 realm 生命周期回收", () => {
  test("disposeRealm 只清理目标 realm 的绑定/订阅，兄弟 realm 仍可解析", async () => {
    const system = new FiberSystem();
    const realmA = Symbol("fiber-realm-a");
    const realmB = Symbol("fiber-realm-b");
    const providerA = system.create(spec({ uid: "t13-provider-a", provide: [svc], realm: realmA }));
    const providerB = system.create(spec({ uid: "t13-provider-b", provide: [svc], realm: realmB }));
    await providerA.refresh();
    await providerB.refresh();
    expect(system.committedFor(svc, realmA)?.value).toBe("svc");
    expect(system.committedFor(svc, realmB)?.value).toBe("svc");

    system.disposeRealm(realmA);
    expect(system.committedFor(svc, realmA)).toBeUndefined();
    expect(system.committedFor(svc, realmB)?.value).toBe("svc");

    system.notify([svc], realmB);
    await system.drain();
    await Promise.all([providerA.remove(), providerB.remove()]);
    expect(system.fibers.size).toBe(0);
  });

  test("realm churn：反复创建/回收不残留 committed binding，兄弟 realm 稳定", async () => {
    const system = new FiberSystem();
    const stableRealm = Symbol("fiber-realm-stable");
    const stable = system.create(spec({ uid: "t13-stable", provide: [dep], realm: stableRealm }));
    await stable.refresh();

    for (let index = 0; index < 12; index += 1) {
      const realm = Symbol(`fiber-realm-churn-${index}`);
      const provider = system.create(spec({ uid: `t13-churn-${index}`, provide: [svc], realm }));
      await provider.refresh();
      expect(system.committedFor(svc, realm)?.value).toBe("svc");
      system.disposeRealm(realm);
      await provider.remove();
      expect(system.committedFor(svc, realm)).toBeUndefined();
      expect(system.committedFor(dep, stableRealm)?.value).toBe("dep");
    }
    await stable.remove();
    expect(system.fibers.size).toBe(0);
  });
});

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
    await provider.refresh();
    expect(provider.state.kind).toBe("PENDING");
    expect(consumer.state.kind).toBe("PENDING");
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
    await fiber.remove();
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

  test("G06 L-Divert：guard 因 target 改变中断后进入 UNLOADING 而非 ACTIVE", async () => {
    const system = new FiberSystem();
    const other = key("other");
    const providerA = system.create(spec({ uid: "provider-A", provide: [svc] }));
    await providerA.refresh();

    let fiber!: Fiber;
    let shouldDivert = false;
    let reachedSecondYield = false;
    fiber = system.create(
      spec({
        uid: "diverter",
        inject: [svc],
        provide: [other],
        apply: async function* () {
          yield () => {};
          if (shouldDivert) {
            // 在两次 guard 检查之间把 target 改为 null：reload 捕获的 target 不再相等。
            fiber.target = null;
          }
          yield () => {};
          reachedSecondYield = true;
        },
      })
    );
    await fiber.refresh();
    expect(fiber.state.kind).toBe("ACTIVE");

    // update 重入 reload；apply 内修改 target → guard 失效后必须进入 UNLOADING 回收。
    shouldDivert = true;
    reachedSecondYield = false;
    const transition = fiber.update();
    expect(fiber.state.kind).toBe("UNLOADING");
    await transition;
    expect(fiber.state.kind).toBe("PENDING");
    expect(reachedSecondYield).toBe(false);
  });

  test("G03 committed Impl.dependents 与 Fiber.dependents 同步登记与撤回", async () => {
    const system = new FiberSystem();
    const provider = system.create(spec({ uid: "provider", provide: [svc] }));
    const consumer = system.create(spec({ uid: "consumer", inject: [svc] }));
    await provider.refresh();
    await consumer.refresh();

    const impl = consumer.target?.get(svc);
    expect(impl).toBeDefined();
    expect(impl!.dependents.has("consumer")).toBe(true);
    expect([...provider.dependents].map((item) => item.uid)).toEqual(["consumer"]);

    await consumer.remove();
    expect(impl!.dependents.has("consumer")).toBe(false);
    expect(provider.dependents.size).toBe(0);
  });

  test("G02 committed Impl.check 由 provider 撤销态注入并动态失效", async () => {
    const system = new FiberSystem();
    const provider = system.create(spec({ uid: "provider", provide: [svc] }));
    const consumer = system.create(spec({ uid: "consumer", inject: [svc] }));
    await provider.refresh();
    await consumer.refresh();

    const impl = consumer.target!.get(svc)!;
    expect(typeof impl.check).toBe("function");
    expect(impl.check!()).toBe(true);
    await consumer.remove();
    await provider.remove();
    expect(impl.check!()).toBe(false);
  });
});
