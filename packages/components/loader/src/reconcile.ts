import type { CoeffectKey, FiberId } from "@zeta-agent/cordis/types";
import { flattenEntries, injectedServices, isDisabled, type Entry } from "./config";

export type ReconcileActionKind = "insert" | "unload" | "reload" | "realm" | "intercept" | "notify";

export interface ReconcileAction {
  readonly kind: ReconcileActionKind;
  readonly entry: Entry;
  readonly previous?: Entry;
  readonly realms?: Readonly<Record<string, symbol>>;
  /** isolate 删除的服务：由执行器迁移绑定，不刷新与该服务无关的 realm。 */
  readonly removedRealms?: readonly string[];
  /** group 子项的父 id / 组 id，供 keyed diff 与 realm 继承使用。 */
  readonly parent?: string;
  readonly group?: string;
  /** inject 解析后的 coeffect key；没有注入解析器时为空数组。 */
  readonly keys?: readonly CoeffectKey<any>[];
}

export interface ReconcileState {
  readonly entries: ReadonlyMap<FiberId, Entry>;
  readonly realms: ReadonlyMap<string, symbol>;
  readonly active: ReadonlySet<FiberId>;
}

export interface ReconcileResult {
  readonly state: ReconcileState;
  readonly actions: readonly ReconcileAction[];
  /** 本轮被显式判定为 disabled 的 key：由 loader 回写，不静默丢弃。 */
  readonly disabled: readonly FiberId[];
}

/** 执行器可以异步；按顺序 await 即形成 name 变化时的「先卸载后插入」屏障。 */
export type ReconcileHost = (action: ReconcileAction) => void | Promise<void>;

export function createReconcileState(): ReconcileState {
  return { entries: new Map(), realms: new Map(), active: new Set() };
}

export function realmKey(id: FiberId, service: string): string {
  return `${id}::${service}`;
}

export function realmFor(state: ReconcileState, id: FiberId, service: string): symbol | undefined {
  return state.realms.get(realmKey(id, service));
}

function sameRecord(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
  const a = left as Readonly<Record<string, unknown>>;
  const b = right as Readonly<Record<string, unknown>>;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((name) => a[name] === b[name]);
}

function assignRealms(
  state: ReconcileState,
  nextEntries: ReadonlyMap<FiberId, Entry>,
  actions: ReconcileAction[]
): Map<string, symbol> {
  const nextRealms = new Map<string, symbol>();
  for (const [id, item] of nextEntries) {
    const previousEntry = state.entries.get(id);
    const oldIsolate = previousEntry?.isolate;
    const newIsolate = item.isolate;
    const services = new Set<string>([
      ...Object.keys(oldIsolate ?? {}),
      ...Object.keys(newIsolate ?? {}),
    ]);
    const removed = Object.keys(oldIsolate ?? {}).filter((service) => newIsolate?.[service] === undefined);
    const entryRealms: Record<string, symbol> = {};
    let changed = false;
    for (const service of services) {
      const oldMode = oldIsolate?.[service];
      const newMode = newIsolate?.[service];
      if (newMode === undefined) {
        changed = true;
        continue;
      }
      const key = realmKey(id, service);
      const realm =
        typeof newMode === "string"
          ? Symbol.for(newMode)
          : oldMode === true
            ? (state.realms.get(key) ?? Symbol(key))
            : Symbol(key);
      nextRealms.set(key, realm);
      entryRealms[service] = realm;
      if (oldMode !== newMode) changed = true;
    }
    if (changed && previousEntry && (Object.keys(entryRealms).length > 0 || removed.length > 0)) {
      actions.push({
        kind: "realm",
        entry: item,
        previous: previousEntry,
        realms: entryRealms,
        ...(removed.length > 0 ? { removedRealms: removed } : {}),
      });
    }
  }
  return nextRealms;
}

export function reconcile(
  state: ReconcileState,
  entries: readonly Entry[],
  scope: Readonly<Record<string, unknown>> = {}
): ReconcileResult {
  const nextEntries = new Map<FiberId, Entry>();
  for (const item of entries) {
    if (typeof item.id !== "string" || item.id.length === 0) throw new Error("INVALID_ENTRY_ID");
    if (typeof item.name !== "string" || item.name.length === 0) throw new Error("INVALID_ENTRY_NAME");
    if (nextEntries.has(item.id)) throw new Error(`DUPLICATE_ENTRY_ID ${item.id}`);
    nextEntries.set(item.id, item);
  }

  const actions: ReconcileAction[] = [];
  const nextRealms = assignRealms(state, nextEntries, actions);
  const nextActive = new Set<FiberId>();
  const ids = new Set<FiberId>([...state.entries.keys(), ...nextEntries.keys()]);

  for (const id of ids) {
    const previous = state.entries.get(id);
    const next = nextEntries.get(id);

    if (!next) {
      if (previous && state.active.has(id)) actions.push({ kind: "unload", entry: previous });
      continue;
    }

    if (!previous) {
      if (!isDisabled(next, scope)) {
        actions.push({ kind: "insert", entry: next });
        nextActive.add(id);
      }
      continue;
    }

    const wasActive = state.active.has(id);
    const nowDisabled = isDisabled(next, scope);
    if (nowDisabled) {
      if (wasActive) actions.push({ kind: "unload", entry: next });
      continue;
    }

    nextActive.add(id);
    if (!wasActive) {
      actions.push({ kind: "insert", entry: next });
      continue;
    }

    if (previous.name !== next.name) {
      actions.push({ kind: "unload", entry: next, previous });
      actions.push({ kind: "insert", entry: next });
      continue;
    }
    if (!sameRecord(previous.intercept, next.intercept)) {
      actions.push({ kind: "intercept", entry: next });
    }
    if (!sameRecord(previous.config, next.config)) {
      actions.push({ kind: next.volatile === true ? "notify" : "reload", entry: next });
    }
  }

  const disabled = [...nextEntries.values()].filter((item) => isDisabled(item, scope)).map((item) => item.id);
  return { state: { entries: nextEntries, realms: nextRealms, active: nextActive }, actions, disabled };
}

export interface ApplyOptions {
  readonly scope?: Readonly<Record<string, unknown>>;
  /** inject 服务名到 CoeffectKey 的解析；缺省时 action.keys 为 []。 */
  readonly resolveKey?: (service: string) => CoeffectKey<any>;
  /** 在执行动作前交付规划结果（含即将提交 realms），供宿主解析目标 realm。 */
  readonly onPlan?: (result: ReconcileResult) => void;
}

/**
 * 从动作规划升级为真正执行器：group 递归 keyed diff、name 变化时先等待旧 fiber 去活、
 * realm 删除携带迁移信息、inject 解析后的 key 参与每个动作。
 * 动作按序 await，调用方无需自行推断卸载与插入的先后。
 */
export async function applyReconcile(
  state: ReconcileState,
  entries: readonly Entry[],
  host: ReconcileHost,
  options: ApplyOptions = {}
): Promise<ReconcileResult> {
  const flat = flattenEntries(entries);
  const result = reconcile(
    state,
    flat.map((item) => item.entry),
    options.scope
  );
  const byId = new Map(flat.map((item) => [item.entry.id, item]));
  for (const action of result.actions) {
    // unload 动作携带的是旧 entry（已从新扁平表移除）；按 key 的 ':' 分层还原父/组归属。
    const separator = action.entry.id.lastIndexOf(":");
    const info =
      byId.get(action.entry.id) ??
      (separator > 0 && state.entries.has(action.entry.id)
        ? {
            entry: action.entry,
            parent: action.entry.id.slice(0, separator),
            group: action.entry.id.slice(0, action.entry.id.indexOf(":")),
          }
        : undefined);
    if (info === undefined) continue;
    const mutable = action as {
      parent?: string;
      group?: string;
      keys?: readonly CoeffectKey<any>[];
    };
    mutable.parent = info.parent;
    mutable.group = info.group;
    mutable.keys = options.resolveKey === undefined ? [] : injectedServices(action.entry).map(options.resolveKey);
  }
  options.onPlan?.(result);
  for (const action of result.actions) await host(action);
  return result;
}

export class Reconciler {
  private current: ReconcileState = createReconcileState();
  private listeners: Array<(action: ReconcileAction) => void> = [];

  get state(): ReconcileState {
    return this.current;
  }

  onAction(listener: (action: ReconcileAction) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((item) => item !== listener);
    };
  }

  reconcile(entries: readonly Entry[], scope: Readonly<Record<string, unknown>> = {}): ReconcileResult {
    const result = reconcile(this.current, entries, scope);
    this.current = result.state;
    for (const action of result.actions) for (const listener of this.listeners) listener(action);
    return result;
  }

  /** 真正执行：动作全部成功才提交状态；任一动作抛错保留旧状态供重试。 */
  async apply(
    entries: readonly Entry[],
    host: ReconcileHost,
    options: ApplyOptions = {}
  ): Promise<ReconcileResult> {
    const result = await applyReconcile(this.current, entries, host, options);
    this.current = result.state;
    for (const action of result.actions) for (const listener of this.listeners) listener(action);
    return result;
  }

  realmFor(id: FiberId, service: string): symbol | undefined {
    return realmFor(this.current, id, service);
  }
}
