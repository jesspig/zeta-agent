import {
  assertAdmitted,
  decideAdmission,
  type AdmissionContext,
  type AdmissionDecision,
  type AdmissionPolicy,
} from "@zeta-agent/framework";

/** 准入只消费 T-19 的 principal/grant/origin，不另建身份或审批路径。 */
export interface ControlAdmission {
  readonly context: AdmissionContext;
  readonly policy?: AdmissionPolicy;
}

export interface ControlLeaseOptions {
  readonly owner: string;
  readonly generation?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly admission?: ControlAdmission;
}

export interface ControlLease {
  readonly owner: string;
  readonly generation: number;
  readonly expiresAt: number;
  readonly active: boolean;
  readonly decision: AdmissionDecision;
  renew(at?: number): boolean;
  release(): void;
  /** 旧进程的迟到消息代次不等于当前权威代次时直接失效。 */
  isCurrent(generation: number): boolean;
}

interface LeaseState {
  readonly owner: string;
  readonly generation: number;
  expiresAt: number;
  active: boolean;
}

interface LeaseDeps {
  readonly now: () => number;
  readonly ttlMs: number;
  readonly decision: AdmissionDecision;
  readonly currentGeneration: () => number;
  readonly onRelease: () => void;
}

function createLease(state: LeaseState, deps: LeaseDeps): ControlLease {
  return {
    get owner() {
      return state.owner;
    },
    get generation() {
      return state.generation;
    },
    get expiresAt() {
      return state.expiresAt;
    },
    get active() {
      return state.active && deps.now() < state.expiresAt;
    },
    get decision() {
      return deps.decision;
    },
    renew(at = deps.now()) {
      if (!state.active || at >= state.expiresAt) {
        state.active = false;
        return false;
      }
      state.expiresAt = at + deps.ttlMs;
      return true;
    },
    release() {
      if (!state.active) return;
      state.active = false;
      deps.onRelease();
    },
    isCurrent(generation) {
      return state.active && generation === deps.currentGeneration();
    },
  };
}

function decide(options: { readonly admission?: ControlAdmission }): AdmissionDecision {
  if (options.admission === undefined) return { kind: "allow" };
  const decision = decideAdmission(options.admission.context, options.admission.policy);
  assertAdmitted(decision);
  return decision;
}

/** 独立租约：用于不需要跨进程协调、只需 fail-closed 准入的单点持有者。 */
export function acquireControlLease(options: ControlLeaseOptions): ControlLease {
  if (typeof options.owner !== "string" || options.owner.length === 0) throw new Error("CONTROL_OWNER_REQUIRED");
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? 30_000;
  const generation = options.generation ?? 1;
  const state: LeaseState = {
    owner: options.owner,
    generation,
    expiresAt: now() + ttlMs,
    active: true,
  };
  return createLease(state, {
    now,
    ttlMs,
    decision: decide(options),
    currentGeneration: () => generation,
    onRelease: () => {},
  });
}

export interface ControlFenceOptions {
  readonly initialGeneration?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly admission?: ControlAdmission;
}

export interface ControlFence {
  readonly generation: number;
  readonly holder: string | undefined;
  readonly lease: ControlLease | undefined;
  /** 已有未过期 holder 时返回 undefined，不抢占、不双启动。 */
  tryAcquire(owner: string): ControlLease | undefined;
  /** 显式替换：无论旧 holder 是否存在都提升代次，旧租约与迟到消息全部失效。 */
  replace(owner: string): ControlLease;
  release(owner: string, generation: number): boolean;
  isCurrent(generation: number): boolean;
  close(): void;
}

/**
 * 控制面租约 + 替换代次栅栏：同一时刻只有一个权威 holder；
 * replace 提升 generation，旧 generation 的 IPC/RPC 帧被 fence 掉。
 */
export function createControlFence(options: ControlFenceOptions = {}): ControlFence {
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? 30_000;
  let generation = options.initialGeneration ?? 1;
  let state: LeaseState | undefined;
  let lease: ControlLease | undefined;
  let closed = false;

  function assertOpen(): void {
    if (closed) throw new Error("CONTROL_FENCE_CLOSED");
  }

  function install(owner: string, force: boolean): ControlLease | undefined {
    assertOpen();
    if (typeof owner !== "string" || owner.length === 0) throw new Error("CONTROL_OWNER_REQUIRED");
    if (state !== undefined && state.active && now() < state.expiresAt && !force) return undefined;
    if (state !== undefined) state.active = false;
    generation += 1;
    const decision = decide(options);
    const next: LeaseState = {
      owner,
      generation,
      expiresAt: now() + ttlMs,
      active: true,
    };
    lease = createLease(next, {
      now,
      ttlMs,
      decision,
      currentGeneration: () => generation,
      onRelease: () => {
        if (state === next) {
          state = undefined;
          lease = undefined;
        }
      },
    });
    state = next;
    return lease;
  }

  return {
    get generation() {
      return generation;
    },
    get holder() {
      return state !== undefined && state.active && now() < state.expiresAt ? state.owner : undefined;
    },
    get lease() {
      return lease;
    },
    tryAcquire(owner) {
      return install(owner, false);
    },
    replace(owner) {
      const next = install(owner, true);
      if (next === undefined) throw new Error("CONTROL_REPLACE_FAILED");
      return next;
    },
    release(owner, atGeneration) {
      if (state === undefined || state.owner !== owner || state.generation !== atGeneration) return false;
      lease?.release();
      return true;
    },
    isCurrent(candidate) {
      return candidate === generation && state !== undefined && state.active;
    },
    close() {
      closed = true;
      if (state !== undefined) state.active = false;
      lease = undefined;
    },
  };
}

/** 租约状态机：ACTIVE --续租失败--> EXPIRED --重新获取--> ACTIVE；RELEASED 为终态。 */
export type LeasePhase = "active" | "expired" | "released";

export interface LeaseRenewerOptions {
  readonly lease: ControlLease;
  readonly ttlMs: number;
  readonly now?: () => number;
  /** 过期后重新获取租约；返回 undefined 表示已被其它 holder 接管，保持 fail-closed。 */
  readonly reacquire?: () => ControlLease | undefined;
  readonly onPhaseChange?: (phase: LeasePhase, reason: string) => void;
}

export interface LeaseRenewer {
  readonly phase: LeasePhase;
  /** phase 为 active 且底层租约未越过 TTL 时才为 true。 */
  readonly active: boolean;
  readonly lease: ControlLease;
  readonly renewals: number;
  readonly failures: number;
  tick(at?: number): boolean;
  reset(lease: ControlLease): void;
  release(): void;
}

/**
 * 显式租约状态机 + 可注入时钟的续租器。daemon 用定时器驱动 tick，
 * 测试可用假时钟直接 tick 而不依赖真实时间。
 */
export function createLeaseRenewer(options: LeaseRenewerOptions): LeaseRenewer {
  if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) throw new Error("CONTROL_LEASE_TTL_INVALID");
  const now = options.now ?? (() => Date.now());
  let current = options.lease;
  let phase: LeasePhase = "active";
  let renewals = 0;
  let failures = 0;

  function change(next: LeasePhase, reason: string): void {
    if (phase === next) return;
    phase = next;
    options.onPhaseChange?.(next, reason);
  }

  return {
    get phase() {
      return phase;
    },
    get active() {
      return phase === "active" && current.active;
    },
    get lease() {
      return current;
    },
    get renewals() {
      return renewals;
    },
    get failures() {
      return failures;
    },
    tick(at = now()) {
      if (phase === "released") return false;
      if (phase === "expired") {
        const recovered = options.reacquire?.();
        if (recovered === undefined || !recovered.active) return false;
        current = recovered;
        change("active", "RECOVERED");
        renewals += 1;
        return true;
      }
      if (current.renew(at)) {
        renewals += 1;
        return true;
      }
      failures += 1;
      change("expired", "RENEW_FAILED");
      return false;
    },
    reset(lease) {
      current = lease;
      change("active", "RESET");
    },
    release() {
      if (phase === "released") return;
      current.release();
      change("released", "RELEASED");
    },
  };
}
