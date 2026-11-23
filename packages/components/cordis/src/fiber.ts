import type { CoeffectKey, Disposer, Effect, Impl, LifecycleState, View } from "@zeta-agent/framework";
import { effect, execute, NOOP, toIterator, unloadHost, type EffectHost } from "./effect";

export function key<T = unknown>(name: string): CoeffectKey<T> {
  return { namespace: "@zeta-agent/testing", name, symbol: Symbol(name) } as CoeffectKey<T>;
}

export interface FiberSpec {
  readonly uid: string;
  readonly inject: readonly CoeffectKey<any>[];
  readonly provide: readonly CoeffectKey<any>[];
  /** 组件配置；经 apply 的第二参数下发给 Component.apply(ctx, config)。 */
  readonly config?: unknown;
  /** 兼容旧调用方 apply(ctx)；新调用方可声明 apply(ctx, config)。 */
  readonly apply?: (ctx: EffectHost, config?: unknown) => Effect | Promise<Effect>;
}

function sameView(left: View | null, right: View | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.size !== right.size) return false;
  for (const [name, impl] of left) {
    if (right.get(name)?.uid !== impl.uid) return false;
  }
  return true;
}

export class FiberSystem {
  readonly fibers = new Map<string, Fiber>();

  create(spec: FiberSpec): Fiber {
    const fiber = new Fiber(this, spec);
    this.fibers.set(spec.uid, fiber);
    return fiber;
  }

  viewFor(names: readonly CoeffectKey<any>[]): View | null {
    const view: View = new Map();
    for (const name of names) {
      const provider = this.providerOf(name, "");
      if (!provider) return null;
      const impl: Impl = {
        uid: provider.uid,
        value: name.name,
        dependents: new Set<string>(),
        isolate: name.symbol,
      };
      view.set(name, impl);
    }
    return view;
  }

  providerOf(name: CoeffectKey<any>, exceptUid: string): Fiber | undefined {
    for (const fiber of this.fibers.values()) {
      if (fiber.uid === exceptUid) continue;
      if (fiber.state.kind !== "ACTIVE") continue;
      if (fiber.spec.provide.some((item) => item.symbol === name.symbol)) return fiber;
    }
    return undefined;
  }
}

export class Fiber {
  state: LifecycleState = { kind: "PENDING" };
  target: View | null = null;
  inertia: Promise<void> | null = null;
  readonly dependents = new Set<Fiber>();
  readonly host: EffectHost;

  get uid(): string {
    return this.spec.uid;
  }

  constructor(readonly system: FiberSystem, readonly spec: FiberSpec) {
    this.host = {
      uid: spec.uid,
      dispose: NOOP,
      effects: [],
      effect: (callback, label) => effect(this.host!, callback, label),
    };
  }

  async refresh(): Promise<void> {
    if (this.state.kind === "DISPOSED" || this.state.kind === "FAILED") return;
    if (this.inertia) await this.inertia;
    const target = this.system.viewFor(this.spec.inject);
    if (sameView(target, this.target)) return;
    this.target = target;
    if (target === null) {
      const previous = this.state;
      this.state = {
        kind: "UNLOADING",
        dispose: "dispose" in previous ? previous.dispose : NOOP,
        committed: "committed" in previous ? previous.committed : new Map(),
      };
      this.inertia = this.unload();
    } else {
      this.state = { kind: "LOADING", iter: toIterator(NOOP), dispose: NOOP, committed: target };
      this.inertia = this.reload(target);
    }
    const running = this.inertia;
    await running;
    if (this.inertia === running) this.inertia = null;
  }

  async update(): Promise<void> {
    if (this.state.kind === "DISPOSED") return;
    this.state = { kind: "PENDING" };
    this.target = null;
    await this.refresh();
  }

  remove(): void {
    if (this.state.kind === "DISPOSED") return;
    this.target = null;
    for (const name of this.spec.inject) {
      this.system.providerOf(name, this.uid)?.dependents.delete(this);
    }
    this.state = { kind: "DISPOSED" };
  }

  private async reload(target: View): Promise<void> {
    try {
      // await 归一 apply 的 Promise<Effect> 形态；Disposer / Iterable / AsyncIterable 原样透传。
      const source: Effect = await (this.spec.apply
        ? this.spec.apply(this.host, this.spec.config)
        : NOOP);
      const dispose: Disposer = await execute(source, () => this.target === target);
      for (const name of this.spec.inject) {
        this.system.providerOf(name, this.uid)?.dependents.add(this);
      }
      this.state = { kind: "ACTIVE", dispose, committed: target };
    } catch (error) {
      this.state = { kind: "FAILED", error };
    }
  }

  private async unload(): Promise<void> {
    while (true) {
      const stillActive = [...this.dependents].some(
        (fiber) =>
          fiber.state.kind !== "PENDING" &&
          fiber.state.kind !== "DISPOSED" &&
          fiber.state.kind !== "FAILED"
      );
      if (!stillActive) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (this.state.kind === "UNLOADING") {
      // 统一回收：state.dispose（apply yield 的逆）+ host.effects（多次顶层 ctx.effect 的逆）。
      // unloadHost 逆序启动 top-level 逆并并发执行；effect 内部 LIFO 与 armed 门控避免重复回收。
      await this.state.dispose();
      await unloadHost(this.host);
      // 清空已回收的顶层逆，避免 reload 后 host.effects 跨生命周期累积。
      (this.host.effects as Disposer[]).length = 0;
    }
    for (const name of this.spec.inject) {
      this.system.providerOf(name, this.uid)?.dependents.delete(this);
    }
    this.state = { kind: "PENDING" };
    if (this.target !== null) {
      const next = this.target;
      this.state = { kind: "LOADING", iter: toIterator(NOOP), dispose: NOOP, committed: next };
      this.inertia = this.reload(next);
      await this.inertia;
    }
  }
}
