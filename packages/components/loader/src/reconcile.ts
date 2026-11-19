import type { FiberId } from "@zeta-agent/framework";
import { isDisabled, type Entry } from "./config";

export type ReconcileActionKind = "insert" | "unload" | "reload" | "realm" | "intercept" | "notify";

export interface ReconcileAction {
  readonly kind: ReconcileActionKind;
  readonly entry: Entry;
  readonly previous?: Entry;
  readonly realms?: Readonly<Record<string, symbol>>;
}

export interface ReconcileState {
  readonly entries: ReadonlyMap<FiberId, Entry>;
  readonly realms: ReadonlyMap<string, symbol>;
  readonly active: ReadonlySet<FiberId>;
}

export interface ReconcileResult {
  readonly state: ReconcileState;
  readonly actions: readonly ReconcileAction[];
}

export type ReconcileHost = (action: ReconcileAction) => void;

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
    if (changed && previousEntry && Object.keys(entryRealms).length > 0) {
      actions.push({ kind: "realm", entry: item, realms: entryRealms });
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

  return { state: { entries: nextEntries, realms: nextRealms, active: nextActive }, actions };
}

export class Reconciler {
  private current: ReconcileState = createReconcileState();
  private listeners: ReconcileHost[] = [];

  get state(): ReconcileState {
    return this.current;
  }

  onAction(listener: ReconcileHost): () => void {
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

  realmFor(id: FiberId, service: string): symbol | undefined {
    return realmFor(this.current, id, service);
  }
}
