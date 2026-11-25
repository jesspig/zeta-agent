import type { CoeffectKey, Component } from "@zeta-agent/cordis/types";
import {
  applyReconcile,
  createReconcileState,
  deriveConfig,
  flattenEntries,
  realmKey,
  type ConfigLayer,
  type Entry,
  type ReconcileAction,
  type ReconcileResult,
  type ReconcileState,
} from "@zeta-agent/loader";
import { defineKey, type Context, type ContextFiber } from "../context";
import { discoverComponents, type ComponentDeclaration } from "./discovery";

export interface LoaderProfile {
  /** 配置层按 bundle → profile → patch → overlay 合并。 */
  readonly layers: readonly ConfigLayer[];
  /** disabled JsExpr 的求值作用域；Loader.setScope 可就地更新。 */
  readonly scope?: Readonly<Record<string, unknown>>;
  /** facet/package 声明或收窄后的 Component 子类；未声明的 entry 显式拒绝。 */
  readonly declarations?: readonly ComponentDeclaration[];
}

export interface RealmMigration {
  readonly id: string;
  readonly service: string;
  readonly from: symbol | undefined;
  readonly to: symbol | undefined;
}

export interface LoaderResult {
  readonly entries: readonly string[];
  readonly actions: readonly ReconcileAction[];
  /** 本轮 disabled 的 key：从 JsExpr/布尔状态回写，不静默丢弃。 */
  readonly disabled: readonly string[];
  readonly migrations: readonly RealmMigration[];
  readonly fibers: ReadonlyMap<string, ContextFiber>;
}

export interface LoaderOptions {
  readonly keyNamespace?: string;
  /** 注入自定义 key 解析可让 facet 复用宿主既有 key 身份。 */
  readonly resolveKey?: (service: string) => CoeffectKey<unknown>;
  readonly declarations?: readonly ComponentDeclaration[];
  readonly onRealmMigration?: (migration: RealmMigration) => void;
}

export interface Loader {
  /** 公开入口：应用用 profile 调用，真实执行 insert/unload/reload/realm/notify。 */
  load(profile: LoaderProfile): Promise<LoaderResult>;
  /** 就地更新 disabled JsExpr 的作用域，便于组件/宿主显式自禁用。 */
  setScope(name: string, value: unknown): void;
  readonly state: ReconcileState;
  realmFor(id: string, service: string): symbol | undefined;
  fiberOf(id: string): ContextFiber | undefined;
  close(): Promise<void>;
}

/**
 * framework facade 的稳定 loader 入口。业务侧只需 `createLoader(ctx).load(profile)`；
 * 所有动作由 reconcile 执行器按序 await，name 变化先等旧 fiber 完全去活。
 */
export function createLoader(ctx: Context, options: LoaderOptions = {}): Loader {
  const namespace = options.keyNamespace ?? "@zeta-agent/entry";
  const keys = new Map<string, CoeffectKey<unknown>>();
  const generatedKey = (service: string): CoeffectKey<unknown> => {
    const existing = keys.get(service);
    if (existing !== undefined) return existing;
    const key = defineKey(namespace, service);
    keys.set(service, key);
    return key;
  };
  const resolveKey = options.resolveKey ?? generatedKey;

  const scope: Record<string, unknown> = {};
  let declarations: readonly ComponentDeclaration[] = options.declarations ?? [];
  let state = createReconcileState();
  let planned = state;
  const fibers = new Map<string, ContextFiber>();
  const migrations: RealmMigration[] = [];
  const disabled = new Set<string>();

  const contextFor = (entry: Entry, id: string): Context => {
    let target: Context = ctx;
    for (const [service, metadata] of Object.entries(entry.intercept ?? {})) {
      target = target.intercept(resolveKey(service), metadata) as Context;
    }
    for (const service of Object.keys(entry.isolate ?? {})) {
      const realm = planned.realms.get(realmKey(id, service));
      if (realm !== undefined) target = target.isolate(resolveKey(service), realm) as Context;
    }
    return target;
  };

  const host = async (action: ReconcileAction): Promise<void> => {
    const id = action.entry.id;
    switch (action.kind) {
      case "insert": {
        const discovery = discoverComponents(declarations);
        const discovered = discovery.resolve(action.entry);
        const component: Component<any> = {
          ...discovered,
          inject: (action.keys ?? discovered.inject) as CoeffectKey<any>[],
        };
        const handle = contextFor(action.entry, id).use(component, action.entry.config);
        fibers.set(id, handle);
        await handle.ready;
        disabled.delete(id);
        break;
      }
      case "unload": {
        const handle = fibers.get(id) ?? (action.previous ? fibers.get(action.previous.id) : undefined);
        if (handle !== undefined) {
          await handle.remove();
          fibers.delete(id);
          if (action.previous) fibers.delete(action.previous.id);
        }
        break;
      }
      case "reload": {
        const handle = fibers.get(id);
        // update(config) 真正把新 config 传入 fiber 的 apply，而非只刷新依赖视图。
        if (handle !== undefined) await handle.update(action.entry.config);
        break;
      }
      case "notify": {
        await ctx.notify((action.keys ?? []) as CoeffectKey<any>[]);
        break;
      }
      case "intercept": {
        const handle = fibers.get(id);
        if (handle !== undefined) await handle.update(action.entry.config);
        break;
      }
      case "realm": {
        for (const service of Object.keys(action.realms ?? {})) {
          const from = state.realms.get(realmKey(id, service));
          const to = action.realms?.[service];
          const migration: RealmMigration = { id, service, from, to };
          migrations.push(migration);
          options.onRealmMigration?.(migration);
        }
        // isolate 删除：所属 binding 迁回根 realm；只记录受影响 key，不触碰无关 realm 的 fiber。
        for (const service of action.removedRealms ?? []) {
          const from = state.realms.get(realmKey(id, service));
          const migration: RealmMigration = { id, service, from, to: ctx.realm };
          migrations.push(migration);
          options.onRealmMigration?.(migration);
        }
        break;
      }
    }
  };

  return {
    async load(profile) {
      const derived = deriveConfig(profile.layers);
      if (profile.scope !== undefined) Object.assign(scope, profile.scope);
      declarations = [...(options.declarations ?? []), ...(profile.declarations ?? [])];
      // 发现层在动作执行前校验：unsupported 条目立即抛错，不静默跳过。
      const discovery = discoverComponents(declarations);
      for (const item of flattenEntries(derived.entries)) discovery.resolve(item.entry);

      const result = await applyReconcile(state, derived.entries, host, {
        scope,
        resolveKey: resolveKey as (service: string) => CoeffectKey<any>,
        onPlan: (plan: ReconcileResult) => {
          planned = plan.state;
        },
      });
      // 宿主需要通过 action 拿到本轮 declarations；用局部标记而非改公共类型。
      void result;
      state = result.state;
      planned = result.state;
      for (const id of result.disabled) disabled.add(id);
      for (const id of result.state.active) disabled.delete(id);
      return {
        entries: result.state.entries.keys().toArray(),
        actions: result.actions,
        disabled: [...disabled].sort(),
        migrations: [...migrations],
        fibers: new Map(fibers),
      };
    },
    setScope(name, value) {
      scope[name] = value;
    },
    get state() {
      return state;
    },
    realmFor(id, service) {
      return state.realms.get(realmKey(id, service));
    },
    fiberOf(id) {
      return fibers.get(id);
    },
    async close() {
      await Promise.all([...fibers.values()].map((handle) => handle.remove()));
      fibers.clear();
    },
  };
}
