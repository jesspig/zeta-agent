/** 项目信任门控：项目本地资源须授权后方可加载。 */
export interface TrustGate {
  /** 判断给定项目根目录是否已授权。 */
  isTrusted(projectRoot: string): boolean;
  /** 授权项目（幂等）。 */
  authorize(projectRoot: string): void;
  /** 撤销项目授权（幂等）。 */
  revoke(projectRoot: string): void;
  /** 已授权项目根目录列表。 */
  trusted(): readonly string[];
}

export function createTrustGate(initial: readonly string[] = []): TrustGate {
  const trustedRoots = new Set<string>(initial.map((root) => normalize(root)));
  return {
    isTrusted(projectRoot) {
      return trustedRoots.has(normalize(projectRoot));
    },
    authorize(projectRoot) {
      trustedRoots.add(normalize(projectRoot));
    },
    revoke(projectRoot) {
      trustedRoots.delete(normalize(projectRoot));
    },
    trusted() {
      return [...trustedRoots];
    },
  };
}

function normalize(root: string): string {
  return root.replace(/[\\/]+$/, "").toLowerCase();
}
