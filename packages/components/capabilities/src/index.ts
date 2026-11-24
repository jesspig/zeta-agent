import type { Disposer } from "@zeta-agent/cordis/types";

export * from "./principal";
export * from "./quota";

export interface Seam<T> {
  readonly ns: string;
  readonly name: string;
  readonly id: symbol;
}

const seams = new Map<symbol, unknown>();

export interface SeamCatalogEntry {
  readonly role: string;
  readonly providers: number;
  readonly consumers: number;
}

const catalog = new Map<symbol, SeamCatalogEntry>();

export function seamCatalog(): SeamCatalogEntry[] {
  return [...catalog.values()];
}

export function createSeam<T>(ns: string, name: string, role = "service"): Seam<T> {
  const seam = { ns, name, id: Symbol(`${ns}:${name}`) };
  catalog.set(seam.id, { role, providers: 0, consumers: 0 });
  return seam;
}

export function provide<T>(seam: Seam<T>, impl: T): Disposer {
  if (seams.has(seam.id)) throw new Error("SEAM_DUPLICATE");
  seams.set(seam.id, impl);
  return () => {
    seams.delete(seam.id);
  };
}

/** 可选解析：缺失 provider 返回 undefined，不抛错。 */
export function resolveOptional<T>(seam: Seam<T>): T | undefined;
export function resolveOptional<C, V>(registry: Registry<C, V>): V;
export function resolveOptional(target: Seam<unknown> | Registry<unknown, unknown>): unknown {
  if ("id" in target) return seams.get(target.id);
  return target.compose(target.contributions as never[]);
}

export function resolve<T>(seam: Seam<T>): T;
export function resolve<C, V>(registry: Registry<C, V>): V;
export function resolve(target: Seam<unknown> | Registry<unknown, unknown>): unknown {
  if ("id" in target) {
    const value = seams.get(target.id);
    if (value === undefined) throw new Error(`SEAM_NOT_PROVIDED: ${target.ns}:${target.name}`);
    return value;
  }
  return target.compose(target.contributions as never[]);
}

export class HealthBoard {
  private readonly claims = new Set<string>();

  claim(name: string): Disposer {
    if (this.claims.has(name)) throw new Error("HEALTH_DUPLICATE");
    this.claims.add(name);
    return () => {
      this.claims.delete(name);
    };
  }

  has(name: string): boolean {
    return this.claims.has(name);
  }
}

export function claim(board: HealthBoard, name: string): Disposer {
  return board.claim(name);
}

export function release(disposer: Disposer): void {
  disposer();
}

export interface Registry<C, V> {
  readonly name: string;
  readonly contributions: C[];
  readonly compose: (items: C[]) => V;
  readonly fallback: V;
}

export function defineRegistry<C, V>(
  name: string,
  options: { compose: (items: C[]) => V; fallback?: V }
): Registry<C, V> {
  return {
    name,
    contributions: [],
    compose: options.compose,
    fallback: options.fallback as V,
  };
}

export function contribute<C, V>(registry: Registry<C, V>, value: C): Disposer {
  registry.contributions.push(value);
  return () => {
    const index = registry.contributions.indexOf(value);
    if (index >= 0) registry.contributions.splice(index, 1);
  };
}

export function compose<C, V>(items: C[], fn: (items: C[]) => V): V {
  return fn(items);
}

export interface ScopedBus<T> {
  on(listener: (payload: T) => void, key: string): Disposer;
  emit(payload: T, key: string): void;
}

export function scoped<T>(name: string): ScopedBus<T> {
  void name;
  const listeners = new Map<string, Array<(payload: T) => void>>();
  return {
    on(listener, key) {
      const bucket = listeners.get(key) ?? [];
      bucket.push(listener);
      listeners.set(key, bucket);
      return () => {
        const current = listeners.get(key) ?? [];
        listeners.set(
          key,
          current.filter((item) => item !== listener)
        );
      };
    },
    emit(payload, key) {
      for (const listener of listeners.get(key) ?? []) listener(payload);
    },
  };
}
