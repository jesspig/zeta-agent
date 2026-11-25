import type { Component, Disposer } from "@zeta-agent/cordis/types";

export interface ComponentNode<C = Component<any>> {
  /** 跨 replace 稳定的 fiber 身份。 */
  readonly uid: string;
  readonly parent?: string;
  readonly config?: unknown;
  readonly realm?: symbol;
  readonly component: C;
  readonly revision: number;
}

export interface RegisterOptions {
  readonly uid?: string;
  readonly parent?: string;
  readonly config?: unknown;
  readonly realm?: symbol;
}

export interface ComponentRegistry<C = Component<any>> {
  register(component: C, options?: RegisterOptions): ComponentNode<C>;
  /**
   * 同身份替换：保留 uid/parent/config/realm，component 换成 replacement，revision 递增。
   * 返回的是新节点而不是就地改 slot，便于观察「替换」与「更新字段」的差别。
   */
  replace(component: C, replacement: C): ComponentNode<C>;
  get(component: C): ComponentNode<C> | undefined;
  byUid(uid: string): ComponentNode<C> | undefined;
  revisionOf(component: C): number;
  readonly size: number;
  watch(listener: (node: ComponentNode<C>, previous: ComponentNode<C> | undefined) => void): Disposer;
}

/** 生成稳定 uid 的策略由调用方注入，避免 registry 依赖全局计数器。 */
export interface RegistryOptions {
  readonly nextUid?: () => string;
}

let seed = 0;
const defaultUid = (): string => `component:${++seed}`;
const componentName = (value: unknown): string => {
  if (typeof value === "object" && value !== null && "name" in value) return String(value.name);
  return "<unknown>";
};

export function createComponentRegistry<C = Component<any>>(
  options: RegistryOptions = {}
): ComponentRegistry<C> {
  const nextUid = options.nextUid ?? defaultUid;
  const nodes = new Map<C, ComponentNode<C>>();
  const byUidIndex = new Map<string, C>();
  const listeners = new Set<(node: ComponentNode<C>, previous: ComponentNode<C> | undefined) => void>();

  const emit = (node: ComponentNode<C>, previous: ComponentNode<C> | undefined): void => {
    for (const listener of [...listeners]) listener(node, previous);
  };

  return {
    register(component, registration = {}) {
      if (nodes.has(component)) throw new Error(`COMPONENT_ALREADY_REGISTERED: ${componentName(component)}`);
      const uid = registration.uid ?? nextUid();
      if (byUidIndex.has(uid)) throw new Error(`DUPLICATE_COMPONENT_UID: ${uid}`);
      const node: ComponentNode<C> = {
        uid,
        component,
        revision: 0,
        ...(registration.parent === undefined ? {} : { parent: registration.parent }),
        ...(registration.config === undefined ? {} : { config: registration.config }),
        ...(registration.realm === undefined ? {} : { realm: registration.realm }),
      };
      nodes.set(component, node);
      byUidIndex.set(uid, component);
      emit(node, undefined);
      return node;
    },
    replace(component, replacement) {
      const previous = nodes.get(component);
      if (previous === undefined) throw new Error(`UNREGISTERED_COMPONENT: ${componentName(component)}`);
      if (nodes.has(replacement)) throw new Error(`COMPONENT_ALREADY_REGISTERED: ${componentName(replacement)}`);
      const next: ComponentNode<C> = {
        uid: previous.uid,
        ...(previous.parent === undefined ? {} : { parent: previous.parent }),
        ...(previous.config === undefined ? {} : { config: previous.config }),
        ...(previous.realm === undefined ? {} : { realm: previous.realm }),
        component: replacement,
        revision: previous.revision + 1,
      };
      nodes.delete(component);
      nodes.set(replacement, next);
      byUidIndex.set(next.uid, replacement);
      emit(next, previous);
      return next;
    },
    get(component) {
      return nodes.get(component);
    },
    byUid(uid) {
      const component = byUidIndex.get(uid);
      return component === undefined ? undefined : nodes.get(component);
    },
    revisionOf(component) {
      return nodes.get(component)?.revision ?? 0;
    },
    get size() {
      return nodes.size;
    },
    watch(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
