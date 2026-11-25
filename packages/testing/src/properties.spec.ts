import { describe, expect, test } from "bun:test";
import {
  CAPABILITY_EXPIRED,
  FiberSystem,
  createNode,
  get,
  key,
  type Fiber,
} from "@zeta-agent/cordis";
import {
  assertNoResidue,
  assertQuiescent,
  observeDispose,
  replayConfig,
  type Disposable,
  type ResidueContext,
} from "./assertions";
import {
  createEffectBridge,
  setActiveEffectBridge,
  type EffectMeta,
} from "@zeta-agent/observability";

const SEEDS = [0x1a2b3c4d, 0x5eed1234, 0x0badf00d, 0x12345678, 0xdecafbad, 0x9e3779b9] as const;

class Lcg {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return this.state;
  }

  int(maxExclusive: number): number {
    return this.next() % maxExclusive;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const output = [...items];
    for (let index = output.length - 1; index > 0; index -= 1) {
      const swap = this.int(index + 1);
      const current = output[index]!;
      output[index] = output[swap]!;
      output[swap] = current;
    }
    return output;
  }
}

async function seeded(seed: number, body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (error) {
    throw new Error(`seed=${seed.toString(16)} ${(error as Error).message}`);
  }
}

function quiescentContext(system: FiberSystem) {
  return {
    fibers: () =>
      [...system.fibers.values()].map((fiber) => ({ uid: fiber.uid, state: fiber.state })),
  };
}

interface TrackedEffect extends Disposable {
  inverseCalls: number;
  dispose(): void;
}

const svcKeys = [key("svc-0"), key("svc-1"), key("svc-2")] as const;

function confluenceSystem(): FiberSystem {
  const system = new FiberSystem();
  for (let index = 0; index < svcKeys.length; index += 1) {
    system.create({ uid: `provider-${index}`, inject: [], provide: [svcKeys[index]!] });
  }
  system.create({ uid: "consumer-0", inject: [svcKeys[0]!, svcKeys[1]!], provide: [] });
  system.create({ uid: "consumer-1", inject: [svcKeys[1]!, svcKeys[2]!], provide: [] });
  system.create({ uid: "consumer-2", inject: [svcKeys[0]!, svcKeys[2]!], provide: [] });
  return system;
}

function observe(system: FiberSystem): unknown {
  const result: Record<string, unknown> = {};
  for (const [uid, fiber] of system.fibers) {
    const view = fiber.target;
    const entries = view
      ? [...view.entries()]
          .map(([coeffect, impl]) => `${coeffect.name}@${impl.uid}`)
          .sort()
      : [];
    result[uid] = { kind: fiber.state.kind, view: entries };
  }
  return result;
}

async function settleInOrder(system: FiberSystem, order: readonly string[]): Promise<unknown> {
  for (let pass = 0; pass < 4; pass += 1) {
    for (const uid of order) {
      await system.fibers.get(uid)!.refresh();
    }
  }
  await assertQuiescent(quiescentContext(system), 1000);
  return observe(system);
}

describe("A3 汇合性", () => {
  const uids = [
    "provider-0",
    "provider-1",
    "provider-2",
    "consumer-0",
    "consumer-1",
    "consumer-2",
  ];

  test("同配置不同随机排列加载后观察状态一致", async () => {
    for (const seed of SEEDS) {
      await seeded(seed, async () => {
        const rng = new Lcg(seed);
        const orders = Array.from({ length: 8 }, () => rng.shuffle(uids));
        const results = new Map<string, unknown>();
        for (const order of orders) {
          results.set(order.join(","), await settleInOrder(confluenceSystem(), order));
        }
        try {
          replayConfig(orders, (order) => results.get(order.join(",")));
        } catch (error) {
          const permutations = orders.map((order) => order.join("/")).join(" | ");
          throw new Error(`permutation=${permutations} ${(error as Error).message}`);
        }
      });
    }
  });
});

function createChurnHarness() {
  const system = new FiberSystem();
  const records: TrackedEffect[] = [];
  const inverseOrder: string[] = [];
  const baseline: Record<string, string> = {};
  const store: Record<string, string> = {};
  const gateKeys = new Map<string, ReturnType<typeof key>>();
  const gates = new Map<string, Fiber>();
  const fibers = new Map<string, Fiber>();
  let generation = 0;

  const context = (): ResidueContext => ({
    effects: () => records,
    snapshot: () => ({ ...store }),
  });

  return {
    system,
    records,
    inverseOrder,
    baseline,
    context,
    async attach(uid: string): Promise<void> {
      const resourceKey = `svc:${uid}`;
      if (!(resourceKey in baseline)) {
        baseline[resourceKey] = "baseline";
        store[resourceKey] = "baseline";
      }
      let gateKey = gateKeys.get(uid);
      if (!gateKey) {
        gateKey = key(`gate:${uid}`);
        gateKeys.set(uid, gateKey);
      }
      let gate = gates.get(uid);
      if (!gate || gate.state.kind === "DISPOSED") {
        generation += 1;
        gate = system.create({
          uid: `gate-${uid}-${generation}`,
          inject: [],
          provide: [gateKey],
        });
        gates.set(uid, gate);
        await gate.refresh();
      }
      let record = records.find((item) => item.uid === uid);
      if (!record) {
        record = { uid, key: resourceKey, inverseCalls: 0, dispose: () => {} };
        records.push(record);
      }
      record.inverseCalls = 0;
      let fiber = fibers.get(uid);
      if (!fiber) {
        fiber = system.create({
          uid,
          inject: [gateKey],
          provide: [],
          apply: () =>
            (function* () {
              store[resourceKey] = "active";
              yield () => {
                record!.inverseCalls += 1;
                store[resourceKey] = "baseline";
                inverseOrder.push(uid);
              };
            })(),
        });
        fibers.set(uid, fiber);
      }
      await fiber.refresh();
    },
    async detach(uid: string): Promise<void> {
      await gates.get(uid)!.remove();
      await fibers.get(uid)!.refresh();
    },
  };
}

function createCascadeHarness(depth: number) {
  const system = new FiberSystem();
  const gateKey = key("cascade-gate");
  const keys = Array.from({ length: depth }, (_, index) => key(`cascade-${index}`));
  const baseline: Record<string, string> = {};
  const store: Record<string, string> = {};
  const inverseOrder: string[] = [];
  const records: TrackedEffect[] = [];
  system.create({ uid: "gate", inject: [], provide: [gateKey] });
  for (let index = 0; index < depth; index += 1) {
    const uid = `level-${index}`;
    const resourceKey = `cascade:${index}`;
    baseline[resourceKey] = "baseline";
    store[resourceKey] = "baseline";
    const record: TrackedEffect = { uid, key: resourceKey, inverseCalls: 0, dispose: () => {} };
    records.push(record);
    system.create({
      uid,
      inject: index === 0 ? [gateKey] : [keys[index - 1]!],
      provide: index < depth - 1 ? [keys[index]!] : [],
      apply: () =>
        (function* () {
          store[resourceKey] = "active";
          yield () => {
            record.inverseCalls += 1;
            store[resourceKey] = "baseline";
            inverseOrder.push(uid);
          };
        })(),
    });
  }
  return {
    system,
    records,
    inverseOrder,
    baseline,
    context: (): ResidueContext => ({ effects: () => records, snapshot: () => ({ ...store }) }),
    async attachAll(): Promise<void> {
      await system.fibers.get("gate")!.refresh();
      for (let index = 0; index < depth; index += 1) {
        await system.fibers.get(`level-${index}`)!.refresh();
      }
    },
    async detachAll(): Promise<void> {
      await system.fibers.get("gate")!.remove();
      const pending = Array.from({ length: depth }, (_, index) =>
        system.fibers.get(`level-${index}`)!.refresh()
      );
      await Promise.all(pending);
    },
  };
}

describe("A4 可逆性", () => {
  test("随机 attach/detach 后逆调用一次且无残留", async () => {
    const pool = ["a", "b", "c", "d"];
    for (const seed of SEEDS) {
      await seeded(seed, async () => {
        const rng = new Lcg(seed);
        const harness = createChurnHarness();
        const attached = new Set<string>();
        for (let step = 0; step < 16; step += 1) {
          const uid = pool[rng.int(pool.length)]!;
          try {
            if (attached.has(uid)) {
              const record = harness.records.find((item) => item.uid === uid)!;
              const before = record.inverseCalls;
              await harness.detach(uid);
              attached.delete(uid);
              expect(record.inverseCalls).toBe(before + 1);
            } else {
              await harness.attach(uid);
              attached.add(uid);
            }
          } catch (error) {
            throw new Error(`step=${step} uid=${uid} ${(error as Error).message}`);
          }
        }
        for (const uid of [...attached]) {
          await harness.detach(uid);
        }
        await assertQuiescent(quiescentContext(harness.system), 1000);
        assertNoResidue(harness.context(), harness.baseline);
        expect(harness.records.length).toBeGreaterThan(0);
      });
    }
  });

  test("级联撤回的逆按 LIFO 执行且无残留", async () => {
    for (const seed of SEEDS.slice(0, 3)) {
      await seeded(seed, async () => {
        const rng = new Lcg(seed);
        const depth = 2 + rng.int(3);
        const harness = createCascadeHarness(depth);
        await harness.attachAll();
        await harness.detachAll();
        await assertQuiescent(quiescentContext(harness.system), 1000);
        observeDispose(harness.records, () => [...harness.inverseOrder]);
        assertNoResidue(harness.context(), harness.baseline);
      });
    }
  });
});

describe("A5 guard 撤回延迟", () => {
  test("provider 撤回 late 时消费者 teardown 仍可读依赖", async () => {
    for (const seed of SEEDS.slice(0, 4)) {
      await seeded(seed, async () => {
        const rng = new Lcg(seed);
        const consumerCount = 1 + rng.int(3);
        const system = new FiberSystem();
        const gateKey = key("a5-gate");
        const svcKey = key<string>("a5-svc");
        const root = createNode("root", null, [svcKey]);
        let withdrawn = false;
        root.committed.set(svcKey, {
          uid: "provider",
          value: "svc-value",
          dependents: new Set<string>(),
          isolate: Symbol("a5"),
          generation: 1,
          check: () => !withdrawn,
        });
        root.keys.set(svcKey.symbol, svcKey);
        const reads: string[] = [];

        system.create({ uid: "gate", inject: [], provide: [gateKey] });
        system.create({
          uid: "provider",
          inject: [gateKey],
          provide: [svcKey],
          apply: () =>
            (function* () {
              yield () => {
                withdrawn = true;
              };
            })(),
        });
        const consumers: Fiber[] = [];
        for (let index = 0; index < consumerCount; index += 1) {
          const uid = `consumer-${index}`;
          const node = createNode(uid, root, [svcKey]);
          const fiber = system.create({
            uid,
            inject: [svcKey],
            provide: [],
            apply: () =>
              (function* () {
                get(node, svcKey);
                yield () => {
                  reads.push(String(get(node, svcKey)));
                };
              })(),
          });
          consumers.push(fiber);
        }

        await system.fibers.get("gate")!.refresh();
        await system.fibers.get("provider")!.refresh();
        for (const consumer of consumers) await consumer.refresh();
        expect(reads).toEqual([]);

        system.fibers.get("gate")!.remove();
        const pending = [system.fibers.get("provider")!.refresh()];
        for (const consumer of consumers) pending.push(consumer.refresh());
        await Promise.all(pending);
        await assertQuiescent(quiescentContext(system), 1000);

        expect(withdrawn).toBe(true);
        expect(reads).toEqual(Array.from({ length: consumerCount }, () => "svc-value"));
        let expired = "";
        try {
          get(root, svcKey);
        } catch (error) {
          expired = (error as Error).message;
        }
        expect(expired).toContain(CAPABILITY_EXPIRED);
      });
    }
  });
});

describe("A21 观测开关一致性", () => {
  function effectSystem(): FiberSystem {
    const system = new FiberSystem();
    const svc = key("a21-svc");
    system.create({ uid: "a21-provider", inject: [], provide: [svc] });
    system.create({
      uid: "a21-consumer",
      inject: [svc],
      provide: [],
      apply: (ctx) => ctx.effect(() => () => {}, "a21-child"),
    });
    return system;
  }

  test("有无 effect 观测时汇合状态一致，且仅在开启时向 bridge 发 meta", async () => {
    const bridge = createEffectBridge("run-a21");
    const metas: EffectMeta[] = [];
    const stop = bridge.onEffect((meta) => metas.push(meta));
    const orders = [
      ["a21-provider", "a21-consumer"],
      ["a21-consumer", "a21-provider"],
    ];
    const results = new Map<string, unknown>();

    for (const observed of [false, true]) {
      const restore = setActiveEffectBridge(observed ? bridge : null);
      try {
        for (const order of orders) {
          results.set(`${observed}:${order.join(",")}`, await settleInOrder(effectSystem(), order));
        }
      } finally {
        restore();
      }
    }
    stop();

    for (const observed of [false, true]) {
      replayConfig(orders, (order) => results.get(`${observed}:${order.join(",")}`));
    }
    expect(results.get(`false:${orders[0]!.join(",")}`)).toEqual(
      results.get(`true:${orders[0]!.join(",")}`)
    );
    expect(metas.length).toBeGreaterThan(0);
    expect(metas.every((meta) => meta.label === "a21-child")).toBe(true);
    expect(metas[0]!.runId).toBe("run-a21");
    expect(metas[0]!.fiberUid).toBe("a21-consumer");
    expect(Array.isArray(metas[0]!.children)).toBe(true);
  });
});
