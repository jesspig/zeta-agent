export type RolloutPhase = "stable" | "canary" | "rollback";

export interface RolloutHost {
  readonly id: string;
  readonly generation: number;
  readonly draining: boolean;
  readonly weight: number;
}

export interface RolloutOptions {
  readonly hosts: readonly string[];
  readonly initialGeneration?: number;
}

export interface RolloutReport {
  readonly canary: string[];
  readonly promoted: string[];
  readonly rolledBack: string[];
  readonly drained: string[];
}

export interface WorkLease {
  release(): void;
}

export interface RolloutController {
  readonly generation: number;
  readonly phase: RolloutPhase;
  readonly previousGeneration: number | undefined;
  hosts(): readonly RolloutHost[];
  generationFor(hostId: string): number;
  /** 路由门禁：消息代次必须与目标 host 当前代次一致，且 host 不在排空中。 */
  route(hostId: string, messageGeneration: number): boolean;
  beginCanary(ids: readonly string[], generation?: number): Promise<RolloutReport>;
  promote(): Promise<RolloutReport>;
  rollback(): Promise<RolloutReport>;
  acquireWork(hostId: string): WorkLease;
  /** 等待所有在途工作释放后结束旧代次 host；返回被排空的 host id。 */
  drain(hostId?: string): Promise<string[]>;
  close(): Promise<void>;
}

interface MutableHost {
  readonly id: string;
  generation: number;
  draining: boolean;
  readonly weight: number;
}

interface MutableReport {
  canary: string[];
  promoted: string[];
  rolledBack: string[];
  drained: string[];
}

function emptyReport(): MutableReport {
  return { canary: [], promoted: [], rolledBack: [], drained: [] };
}

export function createRollout(options: RolloutOptions): RolloutController {
  if (!Array.isArray(options.hosts) || options.hosts.length === 0) throw new Error("INVALID_ROLLOUT_HOSTS");
  const initial = options.initialGeneration ?? 1;
  const hosts = new Map<string, MutableHost>();
  for (const id of options.hosts) {
    if (typeof id !== "string" || id.length === 0 || hosts.has(id)) throw new Error("INVALID_ROLLOUT_HOST");
    hosts.set(id, { id, generation: initial, draining: false, weight: 1 / options.hosts.length });
  }
  const work = new Map<string, Set<symbol>>();
  let generation = initial;
  let previousGeneration: number | undefined;
  let phase: RolloutPhase = "stable";
  let closed = false;

  function assertOpen(): void {
    if (closed) throw new Error("ROLLOUT_CLOSED");
  }

  function assertHost(hostId: string): MutableHost {
    const host = hosts.get(hostId);
    if (host === undefined) throw new Error("UNKNOWN_ROLLOUT_HOST");
    return host;
  }

  return {
    get generation(): number {
      return generation;
    },
    get phase(): RolloutPhase {
      return phase;
    },
    get previousGeneration(): number | undefined {
      return previousGeneration;
    },
    hosts() {
      return [...hosts.values()].map((host) => ({
        id: host.id,
        generation: host.generation,
        draining: host.draining,
        weight: host.weight,
      }));
    },
    generationFor(hostId) {
      return assertHost(hostId).generation;
    },
    route(hostId, messageGeneration) {
      if (closed) return false;
      const host = hosts.get(hostId);
      if (host === undefined || host.draining) return false;
      return host.generation === messageGeneration;
    },
    async beginCanary(ids, next) {
      assertOpen();
      const target = next ?? generation + 1;
      if (!Array.isArray(ids) || ids.length === 0) throw new Error("INVALID_CANARY_HOSTS");
      const selected = ids.map(assertHost);
      previousGeneration = generation;
      for (const host of selected) host.generation = target;
      generation = target;
      phase = "canary";
      const report = emptyReport();
      report.canary = selected.map((host) => host.id);
      return report;
    },
    async promote() {
      assertOpen();
      const report = emptyReport();
      for (const host of hosts.values()) {
        if (host.generation === generation) continue;
        host.generation = generation;
        report.promoted.push(host.id);
      }
      phase = "stable";
      return report;
    },
    async rollback() {
      assertOpen();
      if (previousGeneration === undefined) throw new Error("ROLLOUT_NO_PREVIOUS_GENERATION");
      const target = previousGeneration;
      const report = emptyReport();
      for (const host of hosts.values()) {
        if (host.generation !== generation) continue;
        host.generation = target;
        host.draining = true;
        report.rolledBack.push(host.id);
      }
      generation = target;
      previousGeneration = undefined;
      phase = "rollback";
      return report;
    },
    acquireWork(hostId) {
      assertOpen();
      const token = Symbol(assertHost(hostId).id);
      let set = work.get(hostId);
      if (set === undefined) {
        set = new Set();
        work.set(hostId, set);
      }
      set.add(token);
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          set?.delete(token);
        },
      };
    },
    async drain(hostId) {
      assertOpen();
      const targets = [...hosts.values()].filter(
        (host) => host.draining && (hostId === undefined || host.id === hostId)
      );
      for (const host of targets) {
        while ((work.get(host.id)?.size ?? 0) > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, 1));
        }
        host.draining = false;
      }
      const report = targets.map((host) => host.id);
      if (report.length > 0) phase = "stable";
      return report;
    },
    async close() {
      closed = true;
    },
  };
}
