import type { CoeffectKey, Disposer, Impl, LifecycleState, View } from "./types";

export const STORE = Symbol("@@store");
export const ISOLATE = Symbol("@@isolate");
export const INTERCEPT = Symbol("@@intercept");
export const METADATA = Symbol("@@metadata");
export const REALM = Symbol("@@realm");
export const RESOLVE = Symbol("@@resolve");
export const FIBER = Symbol("@@fiber");

export const UNDECLARED_ACCESS = "UNDECLARED_ACCESS";
export const INACTIVE_ACCESS = "INACTIVE_ACCESS";
export const CAPABILITY_EXPIRED = "CAPABILITY_EXPIRED";

export interface CommittedViewOwner {
  readonly state: LifecycleState;
}

export interface ReflectNode {
  readonly uid: string;
  readonly parent: ReflectNode | null;
  readonly declared: ReadonlySet<symbol>;
  readonly keys: Map<symbol, CoeffectKey<any>>;
  readonly committed: View;
  readonly [STORE]: Map<symbol, unknown>;
  readonly [ISOLATE]: Map<symbol, symbol>;
  readonly [INTERCEPT]: Map<symbol, (value: unknown) => unknown>;
  readonly [METADATA]: Map<symbol, unknown>;
  [REALM]: symbol;
  [RESOLVE]?: (key: CoeffectKey<any>, realm: symbol) => Impl | undefined;
  [FIBER]?: CommittedViewOwner;
}

let generationSeed = 0;

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
    [METADATA]: new Map(),
    [REALM]: Symbol(`realm:${uid}`),
  };
}

export function bindRealm(node: ReflectNode, realm: symbol): void {
  node[REALM] = realm;
}

export function bindResolver(
  node: ReflectNode,
  resolver: ReflectNode[typeof RESOLVE]
): void {
  node[RESOLVE] = resolver;
}

export function bindFiber(node: ReflectNode, owner: CommittedViewOwner): void {
  node[FIBER] = owner;
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
    generation: ++generationSeed,
    ...(check ? { check } : {}),
  };
  node.committed.set(key, impl);
  node.keys.set(key.symbol, key);
}

/** per-key realm 派生：只有声明了 isolate 的键走派生 realm，其余键回到根 realm。 */
export function isolate(
  node: ReflectNode,
  key: CoeffectKey<any>,
  realm: symbol
): ReflectNode {
  const derived = createNode(`${node.uid}:isolate:${realm.toString()}`, node, [key]);
  derived[ISOLATE].set(key.symbol, realm);
  bindRealm(derived, node[REALM]);
  return derived;
}

/** 函数 metadata 保持 transform 兼容；对象 metadata 供 provider consult，不参与值变换。 */
export function intercept(
  node: ReflectNode,
  key: CoeffectKey<any>,
  transform: (value: unknown) => unknown
): ReflectNode;
export function intercept(node: ReflectNode, key: CoeffectKey<any>, metadata: unknown): ReflectNode;
export function intercept(
  node: ReflectNode,
  key: CoeffectKey<any>,
  metadata: unknown
): ReflectNode {
  const derived = createNode(`${node.uid}:intercept`, node, [key]);
  if (typeof metadata === "function") {
    derived[INTERCEPT].set(key.symbol, metadata as (value: unknown) => unknown);
  } else {
    derived[METADATA].set(key.symbol, metadata);
  }
  bindRealm(derived, node[REALM]);
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

/** 同一键沿链最近的 isolate 声明决定其 realm；未声明的键使用根 realm。 */
export function keyRealm(node: ReflectNode, key: CoeffectKey<any>): symbol {
  for (let cursor: ReflectNode | null = node; cursor; cursor = cursor.parent) {
    const isolated = cursor[ISOLATE].get(key.symbol);
    if (isolated !== undefined) return isolated;
  }
  let root = node;
  while (root.parent) root = root.parent;
  return root[REALM];
}

/** 对象 metadata 由根到派生右偏合并；派生 context 的元数据优先。 */
export function metadataOf(node: ReflectNode, key: CoeffectKey<any>): unknown {
  let merged: Record<string, unknown> | undefined;
  for (const item of [...chainOf(node)].reverse()) {
    const metadata = item[METADATA].get(key.symbol);
    if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) continue;
    merged = { ...(merged ?? {}), ...(metadata as Record<string, unknown>) };
  }
  return merged;
}

type Lookup =
  | { kind: "value"; value: unknown }
  | { kind: "expired" }
  | { kind: "inactive" }
  | { kind: "undeclared" };

type Resolved = Lookup & { readonly declared: boolean };

function readLookup(impl: Impl | undefined, chain: ReflectNode[], key: CoeffectKey<any>): Lookup {
  if (!impl) return { kind: "inactive" };
  if (impl.check && !impl.check()) return { kind: "expired" };
  const metadata = metadataOf(chain[0]!, key);
  if (metadata !== undefined && impl.consult && !impl.consult(metadata)) return { kind: "expired" };
  return { kind: "value", value: impl.value };
}

function lookup(node: ReflectNode, key: CoeffectKey<any>, committedOnly: boolean): Resolved {
  const chain = chainOf(node);
  const declared = chain.some((item) => item.declared.has(key.symbol) || item.keys.has(key.symbol));
  const owner = chain.find((item) => item[FIBER])?.[FIBER];
  const realm = keyRealm(node, key);
  let result: Lookup | undefined;

  // committed view 优先；provider fiber 读取自身提供的键也走同一解析链。
  if (owner && "committed" in owner.state) {
    const own = owner.state.committed.get(key);
    if (own) result = readLookup(own, chain, key);
  }
  if (!result || result.kind === "inactive") {
    for (const item of chain) {
      if (!item[RESOLVE]) continue;
      const resolved = readLookup(item[RESOLVE](key, realm), chain, key);
      if (resolved.kind !== "inactive") {
        result = resolved;
        break;
      }
    }
  }
  if (!result || result.kind === "inactive") {
    // 低层 reflect 调用方仍可直接使用 commit/set；生产 Proxy 门禁不读裸 store。
    for (const item of chain) {
      if (!committedOnly && item[STORE].has(key.symbol)) {
        result = readLookup(
          {
            uid: item.uid,
            value: item[STORE].get(key.symbol),
            dependents: new Set<string>(),
            isolate: realm,
            generation: 0,
          },
          chain,
          key
        );
        break;
      }
      if (item[ISOLATE].has(key.symbol)) break;
      const committed = item.committed.get(key);
      if (committed) {
        result = readLookup(committed, chain, key);
        break;
      }
    }
  }
  const resolved: Lookup = result ?? { kind: declared ? "inactive" : "undeclared" };
  return { ...resolved, declared };
}

function deliver(node: ReflectNode, key: CoeffectKey<any>, result: Resolved, strict: boolean): unknown {
  if (result.kind === "value") return applyInterceptors(chainOf(node), key, result.value);
  if (!strict) return undefined;
  if (result.kind === "expired") throw new Error(CAPABILITY_EXPIRED);
  if (result.kind === "undeclared" || !result.declared) throw new Error(UNDECLARED_ACCESS);
  throw new Error(INACTIVE_ACCESS);
}

/** 严格访问（默认）或显式非严格查询（strict=false → undefined）。 */
export function get(node: ReflectNode, key: CoeffectKey<any>, strict = true): unknown {
  return deliver(node, key, lookup(node, key, false), strict);
}

/** Proxy 门禁专用：只认 committed view（provider 绑定/fiber committed），不认裸 store。 */
export function getCommitted(node: ReflectNode, key: CoeffectKey<any>, strict = true): unknown {
  return deliver(node, key, lookup(node, key, true), strict);
}

function applyInterceptors(chain: ReflectNode[], key: CoeffectKey<any>, initial: unknown): unknown {
  let value = initial;
  for (const item of [...chain].reverse()) {
    const transform = item[INTERCEPT].get(key.symbol);
    if (transform) value = transform(value);
  }
  return value;
}

/** realm store 的唯一写入原语：记录旧值，返回的 disposer 精确恢复。 */
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
      if (!found) throw new Error(UNDECLARED_ACCESS);
      return getCommitted(node, found);
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
