import type { Disposer } from "@zeta-agent/cordis/types";

/** 多租户主体：realm 是 per-space 的强隔离身份，禁止跨 space 复用。 */
export interface Principal {
  readonly userId: string;
  readonly spaceId: string;
  readonly realm: symbol;
}

export interface PrincipalInput {
  readonly userId?: string;
  readonly spaceId?: string;
}

export type PrincipalResolver = (input?: PrincipalInput) => Principal;

export interface PrincipalResolverOptions {
  readonly defaultSpaceId?: string;
  readonly defaultUserId?: string;
}

const realmCache = new Map<string, symbol>();

/** 同一 spaceId 始终得到同一 realm symbol；不同 spaceId 永不复用。 */
export function realmForSpace(spaceId: string): symbol {
  const cached = realmCache.get(spaceId);
  if (cached !== undefined) return cached;
  const realm = Symbol(`realm:space:${spaceId}`);
  realmCache.set(spaceId, realm);
  return realm;
}

export function createPrincipalResolver(options: PrincipalResolverOptions = {}): PrincipalResolver {
  const defaultSpaceId = options.defaultSpaceId ?? "default";
  const defaultUserId = options.defaultUserId ?? "system";
  return (input = {}) => {
    const spaceId = input.spaceId ?? defaultSpaceId;
    const userId = input.userId ?? defaultUserId;
    return Object.freeze({ userId, spaceId, realm: realmForSpace(spaceId) });
  };
}

/** realm → 服务 的强隔离桶；没有父桶回退，也没有跨 realm 解析。 */
export class RealmScoped<T> {
  private readonly values = new Map<symbol, T>();

  provide(realm: symbol, value: T): Disposer {
    if (this.values.has(realm)) throw new Error("REALM_SCOPE_DUPLICATE");
    this.values.set(realm, value);
    let armed = true;
    return () => {
      if (!armed) return;
      armed = false;
      if (this.values.get(realm) === value) this.values.delete(realm);
    };
  }

  get(realm: symbol): T | undefined {
    return this.values.get(realm);
  }

  has(realm: symbol): boolean {
    return this.values.has(realm);
  }

  require(realm: symbol): T {
    const value = this.values.get(realm);
    if (value === undefined) throw new Error("REALM_SCOPE_MISSING");
    return value;
  }

  disposeRealm(realm: symbol): void {
    this.values.delete(realm);
  }

  dispose(): void {
    this.values.clear();
  }
}
