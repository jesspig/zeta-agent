import { realmForSpace } from "@zeta-agent/capabilities";
import type { AuditSink } from "@zeta-agent/security";
import type { ControlAction } from "../assembly/protocol";
import {
  assertFrozenImmutable,
  identityDigest,
  stableEvidenceStringify,
  type EpisodeIdentity,
  type EvidenceTree,
  type FrozenSnapshot,
  type FrozenStore,
} from "./frozen";

export type ResearchPermission = "trace" | "score" | "verdict";

export const PERMISSION_RANK: Readonly<Record<ResearchPermission, number>> = Object.freeze({
  trace: 1,
  score: 2,
  verdict: 3,
});

export class ResearchPermissionError extends Error {
  readonly granted: ResearchPermission;
  readonly required: ResearchPermission;

  constructor(granted: ResearchPermission, required: ResearchPermission) {
    super(`PERMISSION_DENIED: ${granted} < ${required}`);
    this.name = "ResearchPermissionError";
    this.granted = granted;
    this.required = required;
  }
}

export function assertPermission(
  granted: ResearchPermission,
  required: ResearchPermission
): true {
  if (PERMISSION_RANK[granted] < PERMISSION_RANK[required]) {
    throw new ResearchPermissionError(granted, required);
  }
  return true;
}

export interface CellMeta {
  readonly id: string;
  readonly label: string;
}

/** proposer 可见视图：ok/delivered 分离，绝不携带 score/verdict。 */
export interface ProbeView {
  readonly cellId: string;
  readonly ok: boolean;
  readonly delivered: boolean;
  readonly meta: CellMeta;
}

export interface Observation {
  readonly cellId: string;
  readonly score: number;
  readonly valid: boolean;
  readonly failClass?: string;
  readonly budgetSpent: number;
  readonly attempt: number;
}

export interface Verdict {
  readonly cellId: string;
  readonly verdict: "pass" | "fail";
  readonly reason?: string;
}

export interface ProbeResult {
  readonly score: number;
  readonly valid: boolean;
  readonly failClass?: string;
  readonly verdict?: "pass" | "fail";
  readonly ok?: boolean;
  readonly delivered?: boolean;
}

export type LiveProbe = (cellId: string) => ProbeResult;

const PROBE_VIEW_LEAK_KEYS = ["score", "verdict", "rubric", "groundtruth", "expected", "passrate"];

export function assertProbeViewNoScore(view: ProbeView): true {
  if (view === null || typeof view !== "object") throw new Error("INVALID_PROBE_VIEW");
  for (const key of Object.keys(view)) {
    const lowered = key.toLowerCase();
    if (PROBE_VIEW_LEAK_KEYS.some((marker) => lowered.includes(marker))) {
      throw new Error(`PROBE_VIEW_LEAK: ${key}`);
    }
  }
  return true;
}

export type DecisionAction =
  | { readonly kind: "probe" | "step"; readonly cellId: string }
  | { readonly kind: "control"; readonly action: ControlAction };

/** T-22 控制协议中的动作白名单，live/replay 共用同一份。 */
export const LEGAL_CONTROL_ACTIONS: readonly ControlAction[] = Object.freeze([
  "prompt",
  "continue",
  "steer",
  "followUp",
  "abort",
  "reset",
]);

export interface ActionState {
  readonly budget: number;
  readonly spent: number;
  readonly cells: readonly CellMeta[];
  readonly evaluated: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** live 与 replay 唯一共享的合法性判定，replay 的冻结前缀检查在其之上叠加。 */
export function isActionLegal(state: ActionState, action: DecisionAction): boolean {
  if (!isRecord(action)) return false;
  if (!Number.isFinite(state.budget) || !Number.isFinite(state.spent)) return false;
  if (state.spent >= state.budget) return false;
  if (action.kind === "control") {
    return typeof action.action === "string" && LEGAL_CONTROL_ACTIONS.includes(action.action);
  }
  if (action.kind !== "probe" && action.kind !== "step") return false;
  if (typeof action.cellId !== "string" || action.cellId.length === 0) return false;
  if (!state.cells.some((cell) => cell.id === action.cellId)) return false;
  if (state.evaluated.includes(action.cellId)) return false;
  return true;
}

export function assertActionLegal(state: ActionState, action: DecisionAction): true {
  if (!isActionLegal(state, action)) {
    const label = isRecord(action) ? String(action.kind) : "unknown";
    throw new Error(`ILLEGAL_ACTION: ${label}`);
  }
  return true;
}

export interface DecisionSurface {
  readonly mode: "live" | "replay";
  readonly identity: EpisodeIdentity;
  readonly budget: number;
  readonly spent: number;
  cells(): readonly CellMeta[];
  isEvaluated(cellId: string): boolean;
  legal(action: DecisionAction): boolean;
  probe(cellId: string): ProbeView;
  observe(cellId: string): Observation;
  verdict(cellId: string): Verdict;
}

interface AuditOptions {
  readonly audit?: AuditSink;
  readonly now?: () => number;
}

function auditRead(
  audit: AuditSink | undefined,
  identity: EpisodeIdentity,
  decision: "RESEARCH_SCORE_READ" | "RESEARCH_VERDICT_READ",
  cellId: string,
  resultDigest: string,
  now: () => number
): void {
  if (audit === undefined) return;
  audit.append({
    ts: now(),
    actor: `research:${identity.run}`,
    tenant: identity.tenant,
    pluginId: "research",
    toolName: "decision-surface",
    argsDigest: identityDigest(identity),
    decision,
    resultDigest,
    causalId: cellId,
  });
}

function assertIdentityEqual(actual: EpisodeIdentity, expected: EpisodeIdentity): void {
  if (
    actual.run !== expected.run ||
    actual.task !== expected.task ||
    actual.tenant !== expected.tenant ||
    actual.domain !== expected.domain ||
    actual.mode !== expected.mode ||
    actual.realm !== expected.realm
  ) {
    throw new Error("IDENTITY_MISMATCH");
  }
}

function assertCellSets(cells: readonly CellMeta[]): void {
  if (!Array.isArray(cells)) throw new Error("INVALID_CELLS");
  const ids = new Set<string>();
  for (const cell of cells) {
    if (cell === null || typeof cell !== "object") throw new Error("INVALID_CELL");
    if (typeof cell.id !== "string" || cell.id.length === 0) throw new Error("INVALID_CELL_ID");
    if (ids.has(cell.id)) throw new Error("DUPLICATE_CELL");
    ids.add(cell.id);
  }
}

interface SurfaceState {
  spent: number;
  evaluated: Set<string>;
  attempts: Map<string, number>;
  observations: Map<string, Observation>;
  verdicts: Map<string, Verdict>;
  views: Map<string, ProbeView>;
  cells: readonly CellMeta[];
}

function createState(cells: readonly CellMeta[]): SurfaceState {
  assertCellSets(cells);
  return {
    spent: 0,
    evaluated: new Set(),
    attempts: new Map(),
    observations: new Map(),
    verdicts: new Map(),
    views: new Map(),
    cells: Object.freeze([...cells]),
  };
}

interface SurfaceCore extends SurfaceState {
  budget: number;
}

function stateOf(state: SurfaceCore): ActionState {
  return {
    budget: state.budget,
    spent: state.spent,
    cells: state.cells,
    evaluated: [...state.evaluated],
  };
}

function commitObservation(
  state: SurfaceCore,
  cellId: string,
  score: number,
  valid: boolean,
  failClass: string | undefined,
  verdict: "pass" | "fail",
  ok: boolean,
  delivered: boolean
): ProbeView {
  const attempt = (state.attempts.get(cellId) ?? 0) + 1;
  state.attempts.set(cellId, attempt);
  state.spent += 1;
  state.evaluated.add(cellId);
  const observation: Observation = Object.freeze({
    cellId,
    score,
    valid,
    ...(failClass === undefined ? {} : { failClass }),
    budgetSpent: state.spent,
    attempt,
  });
  const verdictRecord: Verdict = Object.freeze({ cellId, verdict });
  const meta = state.cells.find((cell) => cell.id === cellId)!;
  const view: ProbeView = Object.freeze({ cellId, ok, delivered, meta });
  assertProbeViewNoScore(view);
  state.observations.set(cellId, observation);
  state.verdicts.set(cellId, verdictRecord);
  state.views.set(cellId, view);
  return view;
}

export interface LiveSurfaceOptions extends AuditOptions {
  readonly identity: EpisodeIdentity;
  readonly budget: number;
  readonly cells: readonly CellMeta[];
  readonly probe: LiveProbe;
}

export function createLiveSurface(options: LiveSurfaceOptions): DecisionSurface {
  if (!Number.isInteger(options.budget) || options.budget < 0) throw new Error("INVALID_BUDGET");
  if (typeof options.probe !== "function") throw new Error("INVALID_LIVE_PROBE");
  const state: SurfaceCore = { ...createState(options.cells), budget: options.budget };
  const now = options.now ?? Date.now;

  return {
    mode: "live",
    identity: options.identity,
    get budget() {
      return state.budget;
    },
    get spent() {
      return state.spent;
    },
    cells: () => state.cells,
    isEvaluated: (cellId) => state.evaluated.has(cellId),
    legal: (action) => isActionLegal(stateOf(state), action),
    probe(cellId) {
      const action: DecisionAction = { kind: "probe", cellId };
      assertActionLegal(stateOf(state), action);
      const result = options.probe(cellId);
      if (result === null || typeof result !== "object") throw new Error("INVALID_PROBE_RESULT");
      if (!Number.isFinite(result.score)) throw new Error("INVALID_PROBE_SCORE");
      return commitObservation(
        state,
        cellId,
        result.score,
        result.valid,
        result.failClass,
        result.verdict ?? (result.score >= 0.5 ? "pass" : "fail"),
        result.ok ?? true,
        result.delivered ?? true
      );
    },
    observe(cellId) {
      const observation = state.observations.get(cellId);
      if (observation === undefined) throw new Error("CELL_NOT_EVALUATED");
      auditRead(options.audit, options.identity, "RESEARCH_SCORE_READ", cellId, observation.score.toString(), now);
      return observation;
    },
    verdict(cellId) {
      const verdict = state.verdicts.get(cellId);
      if (verdict === undefined) throw new Error("CELL_NOT_EVALUATED");
      auditRead(options.audit, options.identity, "RESEARCH_VERDICT_READ", cellId, verdict.verdict, now);
      return verdict;
    },
  };
}

export const EPISODE_LOG_PATH = "episodes.json";

export interface EpisodeOutcome {
  readonly cellId: string;
  readonly score: number;
  readonly valid: boolean;
  readonly failed: boolean;
  readonly failClass?: string;
}

/** 决策剧情事件流：before / batch / parallelism / outcomes / after。 */
export interface EpisodeEvent {
  readonly identity: EpisodeIdentity;
  readonly before: readonly CellMeta[];
  readonly batch: readonly DecisionAction[];
  readonly parallelism: number;
  readonly outcomes: readonly EpisodeOutcome[];
  readonly after: readonly CellMeta[];
}

export function episodeEvidence(events: readonly EpisodeEvent[]): EvidenceTree {
  if (!Array.isArray(events)) throw new Error("INVALID_EPISODE_EVENTS");
  for (const event of events) assertEpisodeEvent(event);
  return Object.freeze({ [EPISODE_LOG_PATH]: stableEvidenceStringify(events) });
}

function assertEpisodeEvent(value: unknown): EpisodeEvent {
  if (!isRecord(value)) throw new Error("INVALID_EPISODE_EVENT");
  if (!isRecord(value.identity) || typeof value.identity.tenant !== "string") {
    throw new Error("INVALID_EPISODE_IDENTITY");
  }
  if (
    !Array.isArray(value.before) ||
    !Array.isArray(value.after) ||
    !Array.isArray(value.batch) ||
    !Array.isArray(value.outcomes) ||
    !Number.isInteger(value.parallelism)
  ) {
    throw new Error("INVALID_EPISODE_EVENT");
  }
  for (const outcome of value.outcomes) {
    if (!isRecord(outcome) || typeof outcome.cellId !== "string" || typeof outcome.score !== "number") {
      throw new Error("INVALID_EPISODE_OUTCOME");
    }
  }
  return Object.freeze({
    ...value,
    identity: Object.freeze({
      ...value.identity,
      realm: realmForSpace(value.identity.tenant),
    }),
  }) as unknown as EpisodeEvent;
}

export function readEpisodeLog(snapshot: FrozenSnapshot): readonly EpisodeEvent[] {
  const raw = snapshot.evidence[EPISODE_LOG_PATH];
  if (typeof raw !== "string") return Object.freeze([]);
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("INVALID_EPISODE_LOG");
  return Object.freeze(parsed.map(assertEpisodeEvent));
}

interface ResolvedFrozen {
  readonly snapshot: FrozenSnapshot;
  readonly events: readonly EpisodeEvent[];
}

function resolveFrozen(options: {
  readonly identity: EpisodeIdentity;
  readonly store: FrozenStore;
  readonly snapshot?: FrozenSnapshot;
  readonly expectedDigest?: string;
}): ResolvedFrozen {
  const snapshot = options.snapshot ?? options.store.latest(identityDigest(options.identity));
  if (snapshot === undefined) throw new Error("FROZEN_NOT_FOUND");
  assertIdentityEqual(snapshot.manifest.identity, options.identity);
  if (options.expectedDigest !== undefined && options.expectedDigest !== snapshot.manifest.digest) {
    throw new Error("DIGEST_MISMATCH");
  }
  assertFrozenImmutable(snapshot);
  return { snapshot, events: readEpisodeLog(snapshot) };
}

export interface ReplaySurfaceOptions extends AuditOptions {
  readonly identity: EpisodeIdentity;
  readonly store: FrozenStore;
  readonly snapshot?: FrozenSnapshot;
  readonly expectedDigest?: string;
}

export function createReplaySurface(options: ReplaySurfaceOptions): DecisionSurface {
  const frozen = resolveFrozen(options);
  const outcomeByCell = new Map<string, EpisodeOutcome>();
  for (const event of frozen.events) {
    for (const outcome of event.outcomes) outcomeByCell.set(outcome.cellId, outcome);
  }
  const cells = eventCells(frozen.events);
  const budget = probesIn(frozen.events);
  const state: SurfaceCore = { ...createState(cells), budget };
  const now = options.now ?? Date.now;

  return {
    mode: "replay",
    identity: options.identity,
    get budget() {
      return state.budget;
    },
    get spent() {
      return state.spent;
    },
    cells: () => state.cells,
    isEvaluated: (cellId) => state.evaluated.has(cellId),
    legal: (action) => isActionLegal(stateOf(state), action),
    probe(cellId) {
      const outcome = outcomeByCell.get(cellId);
      if (outcome === undefined) throw new Error(`REPLAY_PREFIX_VIOLATION: ${cellId}`);
      const action: DecisionAction = { kind: "probe", cellId };
      assertActionLegal(stateOf(state), action);
      return commitObservation(
        state,
        cellId,
        outcome.failed ? 0 : outcome.score,
        outcome.valid,
        outcome.failClass,
        outcome.failed || outcome.score < 0.5 ? "fail" : "pass",
        !outcome.failed,
        outcome.valid
      );
    },
    observe(cellId) {
      const observation = state.observations.get(cellId);
      if (observation === undefined) throw new Error("CELL_NOT_EVALUATED");
      auditRead(options.audit, options.identity, "RESEARCH_SCORE_READ", cellId, observation.score.toString(), now);
      return observation;
    },
    verdict(cellId) {
      const verdict = state.verdicts.get(cellId);
      if (verdict === undefined) throw new Error("CELL_NOT_EVALUATED");
      auditRead(options.audit, options.identity, "RESEARCH_VERDICT_READ", cellId, verdict.verdict, now);
      return verdict;
    },
  };
}

function eventCells(events: readonly EpisodeEvent[]): readonly CellMeta[] {
  const cells = new Map<string, CellMeta>();
  for (const event of events) {
    for (const cell of [...event.before, ...event.after]) {
      if (!cells.has(cell.id)) cells.set(cell.id, cell);
    }
  }
  return [...cells.values()];
}

function probesIn(events: readonly EpisodeEvent[]): number {
  return events.reduce(
    (total, event) => total + event.batch.filter((action) => action.kind !== "control").length,
    0
  );
}

export interface PolicyResult {
  readonly mode: "live" | "replay";
  readonly order: readonly string[];
  readonly budget: number;
  readonly spent: number;
  readonly best: number;
  readonly observations: readonly Observation[];
}

/** 同一 policy 动作序列可直接喂给 live/replay 两个 surface。 */
export function runPolicy(
  surface: DecisionSurface,
  actions: readonly DecisionAction[]
): PolicyResult {
  const order: string[] = [];
  const observations: Observation[] = [];
  let best = 0;
  for (const action of actions) {
    if (action.kind !== "probe" && action.kind !== "step") continue;
    if (!surface.legal(action)) continue;
    surface.probe(action.cellId);
    const observation = surface.observe(action.cellId);
    order.push(action.cellId);
    observations.push(observation);
    best = Math.max(best, observation.score);
  }
  return Object.freeze({
    mode: surface.mode,
    order: Object.freeze(order),
    budget: surface.budget,
    spent: surface.spent,
    best,
    observations: Object.freeze(observations),
  });
}

export interface ReplayOptions extends AuditOptions {
  readonly identity: EpisodeIdentity;
  readonly store: FrozenStore;
  readonly snapshot?: FrozenSnapshot;
  readonly expectedDigest?: string;
  readonly budget?: number;
  /** incumbent 分数纳入 runBest，使 best ≤ runBest 成为真实约束。 */
  readonly incumbentScore?: number;
}

export interface ReplayResult {
  readonly mode: "replay";
  readonly identityDigest: string;
  readonly budget: number;
  readonly spent: number;
  readonly order: readonly string[];
  readonly best: number;
  readonly runBest: number;
  readonly legal: readonly boolean[];
  readonly failed: readonly string[];
  readonly observations: readonly Observation[];
}

/** 按冻结前缀顺序重放，记录预算/顺序/best；失败尝试记 0 且仍消耗预算。 */
export function replayEpisode(events: readonly EpisodeEvent[], options: ReplayOptions): ReplayResult {
  if (!Array.isArray(events)) throw new Error("INVALID_EPISODE_EVENTS");
  const frozen = resolveFrozen(options);
  if (stableEvidenceStringify(frozen.events) !== stableEvidenceStringify(events)) {
    throw new Error("REPLAY_PREFIX_MISMATCH");
  }

  const totalBudget = options.budget ?? probesIn(events);
  if (!Number.isInteger(totalBudget) || totalBudget < 0) throw new Error("INVALID_BUDGET");
  const budget = totalBudget;
  const state: SurfaceCore = { ...createState(eventCells(events)), budget };
  const order: string[] = [];
  const legalFlags: boolean[] = [];
  const failed: string[] = [];
  const observations: Observation[] = [];
  let best = Number.NEGATIVE_INFINITY;
  let runBest =
    options.incumbentScore === undefined ? Number.NEGATIVE_INFINITY : options.incumbentScore;
  if (options.incumbentScore !== undefined && !Number.isFinite(options.incumbentScore)) {
    throw new Error("INVALID_INCUMBENT_SCORE");
  }

  for (const event of events) {
    assertEpisodeEvent(event);
    if (event.parallelism < 1 || event.parallelism > event.batch.length) {
      throw new Error("INVALID_PARALLELISM");
    }
    for (const action of event.batch) {
      if (action.kind === "control") {
        if (!isActionLegal(stateOf(state), action)) throw new Error("ILLEGAL_ACTION: control");
        legalFlags.push(true);
        continue;
      }
      if (!isActionLegal(stateOf(state), action)) {
        throw new Error(`ILLEGAL_ACTION: ${action.cellId}`);
      }
      const outcome = event.outcomes.find((item: EpisodeOutcome) => item.cellId === action.cellId);
      if (outcome === undefined) throw new Error(`REPLAY_OUTCOME_MISSING: ${action.cellId}`);
      if (!Number.isFinite(outcome.score)) throw new Error("INVALID_OUTCOME_SCORE");
      const score = outcome.failed ? 0 : outcome.score;
      const view = commitObservation(
        state,
        action.cellId,
        score,
        outcome.valid,
        outcome.failClass,
        outcome.failed || score < 0.5 ? "fail" : "pass",
        !outcome.failed,
        outcome.valid
      );
      assertProbeViewNoScore(view);
      const observation = state.observations.get(action.cellId)!;
      order.push(action.cellId);
      legalFlags.push(true);
      if (outcome.failed) failed.push(action.cellId);
      observations.push(observation);
      best = Math.max(best, score);
      runBest = Math.max(runBest, score);
    }
  }

  return Object.freeze({
    mode: "replay",
    identityDigest: identityDigest(options.identity),
    budget,
    spent: state.spent,
    order: Object.freeze(order),
    best: best === Number.NEGATIVE_INFINITY ? 0 : best,
    runBest: runBest === Number.NEGATIVE_INFINITY ? 0 : runBest,
    legal: Object.freeze(legalFlags),
    failed: Object.freeze(failed),
    observations: Object.freeze(observations),
  });
}

export interface ReplayInvariantOptions {
  readonly expectedBudget?: number;
  readonly expectedSpent?: number;
}

export function assertReplayInvariants(
  result: ReplayResult,
  options: ReplayInvariantOptions = {}
): true {
  if (result.spent !== result.order.length) throw new Error("REPLAY_BUDGET_ORDER_MISMATCH");
  if (new Set(result.order).size !== result.order.length) throw new Error("REPLAY_DUPLICATE_ACTION");
  if (result.legal.some((value) => !value)) throw new Error("REPLAY_ILLEGAL_ACTION");
  if (result.best > result.runBest) throw new Error("REPLAY_BEST_RUNBEST_VIOLATION");
  if (result.spent > result.budget) throw new Error("REPLAY_BUDGET_EXCEEDED");
  if (options.expectedBudget !== undefined && result.budget !== options.expectedBudget) {
    throw new Error("REPLAY_BUDGET_MISMATCH");
  }
  if (options.expectedSpent !== undefined && result.spent !== options.expectedSpent) {
    throw new Error("REPLAY_SPENT_MISMATCH");
  }
  for (const cellId of result.failed) {
    if (!result.order.includes(cellId)) throw new Error("REPLAY_FAILED_ATTEMPT_SKIPPED");
    if (result.observations.find((item) => item.cellId === cellId)?.score !== 0) {
      throw new Error("REPLAY_FAILED_ATTEMPT_SCORED");
    }
  }
  return true;
}

export interface ScopedDecisionSurface {
  readonly permission: ResearchPermission;
  readonly mode: "live" | "replay";
  readonly identity: EpisodeIdentity;
  readonly budget: number;
  cells(): readonly CellMeta[];
  probe(cellId: string): ProbeView;
  observe(cellId: string): Observation;
  verdict(cellId: string): Verdict;
}

export function createScopedSurface(
  surface: DecisionSurface,
  permission: ResearchPermission,
  auditOptions: AuditOptions = {}
): ScopedDecisionSurface {
  if (!isRecord(surface)) throw new Error("INVALID_DECISION_SURFACE");
  const now = auditOptions.now ?? Date.now;
  return {
    permission,
    mode: surface.mode,
    identity: surface.identity,
    budget: surface.budget,
    cells: () => surface.cells(),
    probe(cellId) {
      const view = surface.probe(cellId);
      assertProbeViewNoScore(view);
      return view;
    },
    observe(cellId) {
      assertPermission(permission, "score");
      const observation = surface.observe(cellId);
      auditRead(auditOptions.audit, surface.identity, "RESEARCH_SCORE_READ", cellId, observation.score.toString(), now);
      return observation;
    },
    verdict(cellId) {
      assertPermission(permission, "verdict");
      const verdict = surface.verdict(cellId);
      auditRead(auditOptions.audit, surface.identity, "RESEARCH_VERDICT_READ", cellId, verdict.verdict, now);
      return verdict;
    },
  };
}

/** proposer 只有 trace 权限：只能拿 ProbeView，永远看不到分数与裁决。 */
export function createProposerSurface(
  surface: DecisionSurface,
  auditOptions: AuditOptions = {}
): ScopedDecisionSurface {
  return createScopedSurface(surface, "trace", auditOptions);
}
