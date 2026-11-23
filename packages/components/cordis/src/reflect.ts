import type { CoeffectKey, Disposer, Impl, View } from "@zeta-agent/framework";

export const STORE = Symbol("@@store");
export const ISOLATE = Symbol("@@isolate");
export const INTERCEPT = Symbol("@@intercept");

export const UNDECLARED_ACCESS = "UNDECLARED_ACCESS";
export const INACTIVE_ACCESS = "INACTIVE_ACCESS";
export const CAPABILITY_EXPIRED = "CAPABILITY_EXPIRED";

export interface ReflectNode {
  readonly uid: string;
  readonly parent: ReflectNode | null;
  readonly declared: ReadonlySet<symbol>;
  readonly keys: Map<symbol, CoeffectKey<any>>;
  readonly committed: View;
  readonly [STORE]: Map<symbol, unknown>;
  readonly [ISOLATE]: Map<symbol, symbol>;
  readonly [INTERCEPT]: Map<symbol, (value: unknown) => unknown>;
}

export function createNode(
  uid: string,
  parent: ReflectNode | null,
  declared: readonly CoeffectKey<any>[]
): ReflectNode {
  const keys = new Map<symbol, CoeffectKey<any>>();
  for (const item of declared) keys.set(item.symbol, item);
  return {
    uid,
    parent,
    declared: new Set(declared.map((item) => item.symbol)),
    keys,
    committed: new Map(),
    [STORE]: new Map(),
    [ISOLATE]: new Map(),
    [INTERCEPT]: new Map(),
  };
}

export function commit(
  node: ReflectNode,
  key: CoeffectKey<any>,
  value: unknown,
  realm: symbol = Symbol("default"),
  check?: () => boolean,
  dependents?: Set<string>
): void {
  const impl: Impl = {
    uid: node.uid,
    value,
    dependents: dependents ?? new Set<string>(),
    isolate: realm,
    ...(check ? { check } : {}),
  };
  node.committed.set(key, impl);
  node.keys.set(key.symbol, key);
}

export function isolate(
  node: ReflectNode,
  key: CoeffectKey<any>,
  realm: symbol
): ReflectNode {
  const derived = createNode(`${node.uid}:${realm.toString()}`, node, [key]);
  derived[ISOLATE].set(key.symbol, realm);
  return derived;
}

export function intercept(
  node: ReflectNode,
  key: CoeffectKey<any>,
  transform: (value: unknown) => unknown
): ReflectNode {
  const derived = createNode(`${node.uid}:intercept`, node, [key]);
  derived[INTERCEPT].set(key.symbol, transform);
  return derived;
}

function chainOf(node: ReflectNode): ReflectNode[] {
  const chain: ReflectNode[] = [];
  let cursor: ReflectNode | null = node;
  while (cursor) {
    chain.push(cursor);
    cursor = cursor.parent;
  }
  return chain;
}

function findKey(node: ReflectNode, symbol: symbol): CoeffectKey<any> | undefined {
  for (const item of chainOf(node)) {
    const found = item.keys.get(symbol);
    if (found) return found;
  }
  return undefined;
}

export function get(node: ReflectNode, key: CoeffectKey<any>): unknown {
  const chain = chainOf(node);
  const declared = chain.some((item) => item.declared.has(key.symbol) || item.keys.has(key.symbol));
  if (!declared) throw new Error(UNDECLARED_ACCESS);

  let value: unknown;
  let found = false;
  for (const item of chain) {
    if (item[STORE].has(key.symbol)) {
      value = item[STORE].get(key.symbol);
      found = true;
      break;
    }
    if (item[ISOLATE].has(key.symbol)) break;
    for (const [candidate, impl] of item.committed) {
      if (candidate.symbol !== key.symbol) continue;
      if (impl.check && !impl.check()) throw new Error(CAPABILITY_EXPIRED);
      value = impl.value;
      found = true;
      break;
    }
    if (found) break;
  }
  if (!found) throw new Error(INACTIVE_ACCESS);

  for (const item of [...chain].reverse()) {
    const transform = item[INTERCEPT].get(key.symbol);
    if (transform) value = transform(value);
  }
  return value;
}

export function set(node: ReflectNode, key: CoeffectKey<any>, value: unknown): Disposer {
  const had = node[STORE].has(key.symbol);
  const previous = node[STORE].get(key.symbol);
  node[STORE].set(key.symbol, value);
  node.keys.set(key.symbol, key);
  return () => {
    if (had) node[STORE].set(key.symbol, previous);
    else node[STORE].delete(key.symbol);
  };
}

export function createProxy<T extends object>(node: ReflectNode): T {
  return new Proxy({} as T, {
    get: (target, property) => {
      if (typeof property !== "symbol") return Reflect.get(target, property);
      const found = findKey(node, property);
      // Proxy 是 capability 门禁：未声明（未提交/未 set）的 symbol 访问一律拒绝。
      if (!found) throw new Error(UNDECLARED_ACCESS);
      return get(node, found);
    },
    set: (target, property, value) => {
      if (typeof property !== "symbol") return false;
      const found = findKey(node, property);
      if (!found) throw new Error(UNDECLARED_ACCESS);
      set(node, found, value);
      return true;
    },
  });
}
