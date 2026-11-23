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
        // G03：committed Impl.dependents 与 provider 的 Fiber.dependents 共享同一集合实例，
        // 使 Thm 70 的撤回延迟有可观测的运行时载体（登记写入见 reload/remove/unload）。
        dependents: provider.committedDependents,
        // G02：动态能力判定由 provider 撤销态注入；provider 非 ACTIVE 时读取抛 CAPABILITY_EXPIRED。
        check: () => provider.state.kind === "ACTIVE",
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
  /** committed Impl.dependents 的共享载体：与 dependents 同步登记 fiber uid。 */
  readonly committedDependents = new Set<string>();
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
      const provider = this.system.providerOf(name, this.uid);
      if (provider) {
        provider.dependents.delete(this);
        provider.committedDependents.delete(this.uid);
      }
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
      if (this.target === target) {
        for (const name of this.spec.inject) {
          const provider = this.system.providerOf(name, this.uid);
          if (provider) {
            provider.dependents.add(this);
            provider.committedDependents.add(this.uid);
          }
        }
        this.state = { kind: "ACTIVE", dispose, committed: target };
      } else {
        // G06：guard 因 target 改变而中断（L-Divert），不能无条件落地为 ACTIVE。
        // 按 core-semantics §7.2 reload 的 else 分支进入 UNLOADING，惯性链入 unload
        // 统一回收已累积的逆，再由 unload 依 target 决定回 PENDING 或重入 reload。
        const previous = this.state;
        this.state = {
          kind: "UNLOADING",
          dispose,
          committed: "committed" in previous ? previous.committed : target,
        };
        this.inertia = this.unload();
        await this.inertia;
      }
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
      const provider = this.system.providerOf(name, this.uid);
      if (provider) {
        provider.dependents.delete(this);
        provider.committedDependents.delete(this.uid);
      }
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
