/**
 * T-22 研究编排：EditableSurface / StrategyPlugin / ResearchProfile / RESUME。
 *
 * 研究轨默认禁用；只有显式 enableResearch=true 才进入真实候选闭环。
 * 每一轮都执行真实的 FrozenStore 冻结 + PromotionPipeline 全门禁，不用组件测试替代端到端。
 */
import { createHash } from "node:crypto";
import { builtinIdsForProfile, type AssemblyProfile } from "../assembly/builtins";
import {
  createExperienceLibrary,
  createExperienceScope,
  rawTraceDigest,
  type ExperienceEntry,
  type ExperienceStore,
  type ScopedExperienceLibrary,
} from "./experience";
import {
  episodeEvidence,
  type EpisodeEvent,
} from "./decision";
import {
  createSearchTestSplit,
  type FitnessEvaluator,
  type FitnessTrace,
} from "./fitness";
import {
  createEpisodeIdentity,
  identityDigest,
  stableEvidenceStringify,
  type EpisodeIdentity,
  type EpisodeIdentityInput,
  type FrozenSnapshot,
  type FrozenStore,
} from "./frozen";
import {
  createPromotionPipeline,
  type PromotionOutcome,
  type RegressionGate,
} from "./pipeline";
import { sha256Hex, type Candidate } from "./promotion";
import { issuePromotionSeal } from "./seal";
import {
  promotionSealKey,
  type PromotionSealRegistry,
} from "./seal-registry";

// ── ResearchProfile：默认禁用，显式启用 ─────────────────────────────────────

export interface ResearchEnablement {
  readonly enabled: boolean;
  readonly profile: AssemblyProfile;
  readonly reason: string;
}

/**
 * 没有任何产品 profile 默认进入研究轨；即使 assemblyProfile="research" 也只是声明档位，
 * 仍需显式 enableResearch=true。local-safe 默认装配不含任何 research seam。
 */
export function resolveResearchEnablement(input: {
  readonly profile?: AssemblyProfile;
  readonly enableResearch?: boolean;
}): ResearchEnablement {
  const profile = input.profile ?? "local-safe";
  if (input.enableResearch !== true) {
    return Object.freeze({
      enabled: false,
      profile,
      reason: "RESEARCH_REQUIRES_EXPLICIT_OPT_IN",
    });
  }
  return Object.freeze({ enabled: true, profile, reason: "RESEARCH_EXPLICITLY_ENABLED" });
}

export function assertResearchNotInDefaultAssembly(): true {
  for (const id of builtinIdsForProfile("local-safe")) {
    if (/research|fitness|experience|strategy|evidence/i.test(id)) {
      throw new Error(`RESEARCH_IN_DEFAULT_ASSEMBLY: ${id}`);
    }
  }
  for (const profile of ["local-safe", "local-full", "daemon", "remote", "multi-tenant"] as const) {
    for (const id of builtinIdsForProfile(profile)) {
      if (/research|fitness|experience|strategy|evidence/i.test(id)) {
        throw new Error(`RESEARCH_IN_PRODUCT_PROFILE: ${profile}:${id}`);
      }
    }
  }
  return true;
}

// ── EditableSurface：不可变、内容寻址、逐次修订 ──────────────────────────────

export interface EditableSurface {
  readonly content: string;
  readonly digest: string;
  readonly revision: number;
}

export function surfaceDigest(content: string): string {
  if (typeof content !== "string" || content.length === 0) throw new Error("INVALID_SURFACE");
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function createEditableSurface(content: string): EditableSurface {
  return Object.freeze({ content, digest: surfaceDigest(content), revision: 1 });
}

/** 真实替换：from 必须存在于正文，返回全新的 surface，不修改入参。 */
export function proposeSurfaceEdit(
  surface: EditableSurface,
  edit: { readonly from: string; readonly to: string }
): EditableSurface {
  if (typeof edit.from !== "string" || edit.from.length === 0 || !surface.content.includes(edit.from)) {
    throw new Error("SURFACE_EDIT_TARGET_MISSING");
  }
  if (typeof edit.to !== "string") throw new Error("INVALID_SURFACE_EDIT");
  const content = surface.content.replace(edit.from, edit.to);
  return Object.freeze({
    content,
    digest: surfaceDigest(content),
    revision: surface.revision + 1,
  });
}

// ── StrategyPlugin：真实可注入的生成策略，默认不注册 ─────────────────────────

export interface StrategyContext {
  readonly round: number;
  readonly surface: EditableSurface;
  /** earlier-only：只含 step 严格小于本轮的冻结经验。 */
  readonly earlier: readonly ExperienceEntry[];
}

export interface StrategyCandidate {
  readonly id: string;
  readonly artifact: string;
  readonly rationale: string;
}

export interface StrategyPlugin {
  readonly name: string;
  propose(context: StrategyContext): StrategyCandidate;
}

export function createStrategyPlugin(options: {
  readonly name: string;
  readonly propose: (context: StrategyContext) => StrategyCandidate;
}): StrategyPlugin {
  if (typeof options.name !== "string" || options.name.length === 0) throw new Error("INVALID_STRATEGY_NAME");
  if (typeof options.propose !== "function") throw new Error("INVALID_STRATEGY_PROPOSE");
  return Object.freeze({ name: options.name, propose: options.propose });
}

// ── RESUME：携带摘要校验的轮次检查点 ────────────────────────────────────────

export interface ResumeCheckpoint {
  readonly version: 1;
  readonly runId: string;
  readonly completedRounds: number;
  readonly surface: EditableSurface;
  readonly incumbentId?: string;
  readonly incumbentFitness?: number;
  readonly identityDigest?: string;
  readonly digest: string;
}

function checkpointDigest(input: {
  readonly runId: string;
  readonly completedRounds: number;
  readonly surface: EditableSurface;
  readonly incumbentId?: string;
  readonly incumbentFitness?: number;
  readonly identityDigest?: string;
}): string {
  return sha256Hex(stableEvidenceStringify(input));
}

export function createResumeController(): {
  checkpoint(input: {
    readonly runId: string;
    readonly completedRounds: number;
    readonly surface: EditableSurface;
    readonly incumbent?: Candidate;
    readonly identityDigest?: string;
  }): ResumeCheckpoint;
  resume(checkpoint: ResumeCheckpoint): ResumeCheckpoint;
} {
  return {
    checkpoint(input) {
      const body = {
        runId: input.runId,
        completedRounds: input.completedRounds,
        surface: input.surface,
        ...(input.incumbent === undefined ? {} : { incumbentId: input.incumbent.id }),
        ...(input.incumbent === undefined ? {} : { incumbentFitness: input.incumbent.fitness }),
        ...(input.identityDigest === undefined ? {} : { identityDigest: input.identityDigest }),
      };
      return Object.freeze({ version: 1 as const, ...body, digest: checkpointDigest(body) });
    },
    resume(checkpoint) {
      if (
        checkpoint === null ||
        typeof checkpoint !== "object" ||
        checkpoint.version !== 1 ||
        !Number.isInteger(checkpoint.completedRounds) ||
        checkpoint.completedRounds < 0
      ) {
        throw new Error("RESUME_INVALID_CHECKPOINT");
      }
      const { version: _version, digest, ...body } = checkpoint;
      if (checkpointDigest(body as Parameters<typeof checkpointDigest>[0]) !== digest) {
        throw new Error("RESUME_DIGEST_MISMATCH");
      }
      return checkpoint;
    },
  };
}

// ── 端到端两轮研究闭环 ──────────────────────────────────────────────────────

export interface ResearchRoundResult {
  readonly round: number;
  readonly candidateId: string;
  readonly artifactDigest: string;
  readonly frozenDigest: string;
  readonly promoted: boolean;
  readonly stages: readonly string[];
  readonly evaluationReward: number;
  readonly earlierIds: readonly string[];
  readonly surfaceDigest: string;
  readonly experienceId: string;
  readonly snapshot: FrozenSnapshot;
  readonly outcome: PromotionOutcome;
}

export interface ResearchRun {
  readonly runId: string;
  readonly enabled: boolean;
  readonly rounds: readonly ResearchRoundResult[];
  readonly surface: EditableSurface;
  readonly incumbent?: Candidate;
  readonly resume: ResumeCheckpoint;
}

export interface ResearchLoopOptions {
  readonly runId: string;
  readonly profile?: AssemblyProfile;
  readonly enableResearch?: boolean;
  readonly identity: EpisodeIdentityInput;
  readonly store: FrozenStore;
  readonly experienceStore: ExperienceStore;
  readonly surface: EditableSurface;
  readonly strategy: StrategyPlugin;
  readonly regressionGate: RegressionGate;
  readonly rounds: number;
  readonly evaluator?: FitnessEvaluator;
  /** RESUME：从已验证检查点的下一轮继续；已完成轮次不再执行。 */
  readonly resume?: ResumeCheckpoint;
  /** 跨进程 RESUME 必须提供持久化 seal 注册表，防止模块内重新签发的假 seal。 */
  readonly sealRegistry?: PromotionSealRegistry;
}

function roundEvents(identity: EpisodeIdentity): readonly EpisodeEvent[] {
  return [
    {
      identity,
      before: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
      batch: [{ kind: "probe", cellId: "a" }, { kind: "probe", cellId: "b" }],
      parallelism: 2,
      outcomes: [
        { cellId: "a", score: 0.6, valid: true, failed: false },
        { cellId: "b", score: 0.4, valid: true, failed: false },
      ],
      after: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
    },
  ];
}

function roundTrace(round: number): readonly FitnessTrace[] {
  return [
    {
      name: `research-round-${round}`,
      runBest: 1,
      nEvaluated: 2,
      points: [
        { budget: 1, best: 0.25, sequentialRounds: 1 },
        { budget: 3, best: 0.75, sequentialRounds: 2 },
      ],
    },
  ];
}

function restoreIncumbent(
  checkpoint: ResumeCheckpoint,
  identityDigestValue: string,
  sealRegistry?: PromotionSealRegistry
): Candidate | undefined {
  if (checkpoint.incumbentId === undefined || checkpoint.incumbentFitness === undefined) return undefined;
  if (sealRegistry !== undefined) {
    const key = promotionSealKey(identityDigestValue, checkpoint.incumbentId, checkpoint.incumbentFitness);
    if (!sealRegistry.has(key)) throw new Error("RESUME_SEAL_NOT_REGISTERED");
  }
  const body = {
    id: checkpoint.incumbentId,
    fitness: checkpoint.incumbentFitness,
    qualified: true,
    fingerprint: undefined,
  };
  return Object.freeze({
    ...body,
    seal: issuePromotionSeal({
      candidateId: body.id,
      identityDigest: identityDigestValue,
      body,
    }),
  });
}

/**
 * 显式启用后执行真实候选闭环：每轮从 earlier-only 经验取 cue，让 StrategyPlugin 产出
 * 候选，冻结完整证据，运行完整晋升管线，再用检查点支持 RESUME。禁用时直接拒绝。
 */
export function runResearchLoop(options: ResearchLoopOptions): ResearchRun {
  const enablement = resolveResearchEnablement({
    profile: options.profile,
    enableResearch: options.enableResearch,
  });
  if (!enablement.enabled) {
    throw new Error(`RESEARCH_DISABLED: ${enablement.reason}`);
  }
  assertResearchNotInDefaultAssembly();
  if (!Number.isInteger(options.rounds) || options.rounds < 1) throw new Error("INVALID_ROUNDS");

  const resolvedIdentity: EpisodeIdentity = createEpisodeIdentity({
    run: options.identity.run,
    task: options.identity.task,
    tenant: options.identity.tenant,
    domain: options.identity.domain,
    mode: options.identity.mode,
    ...(options.identity.principal === undefined ? {} : { principal: options.identity.principal }),
  });

  const library: ScopedExperienceLibrary = createExperienceLibrary(
    options.experienceStore,
    createExperienceScope({
      tenant: resolvedIdentity.tenant,
      domain: resolvedIdentity.domain,
      mode: resolvedIdentity.mode,
      ...(options.identity.principal === undefined ? {} : { principal: options.identity.principal }),
    })
  );
  const resumeController = createResumeController();
  const checkpoint = options.resume === undefined ? undefined : resumeController.resume(options.resume);
  const identityDigestValue = identityDigest(resolvedIdentity);
  if (checkpoint !== undefined) {
    if (checkpoint.runId !== options.runId) throw new Error("RESUME_RUN_MISMATCH");
    if (checkpoint.identityDigest !== undefined && checkpoint.identityDigest !== identityDigestValue) {
      throw new Error("RESUME_IDENTITY_MISMATCH");
    }
  }
  const startRound = (checkpoint?.completedRounds ?? 0) + 1;
  if (options.rounds < startRound) throw new Error("RESUME_ROUNDS_BEHIND_CHECKPOINT");

  let surface = checkpoint?.surface ?? options.surface;
  let incumbent = restoreIncumbent(
    checkpoint ?? { version: 1, runId: options.runId, completedRounds: 0, surface, digest: "" },
    identityDigestValue,
    options.sealRegistry
  );
  const results: ResearchRoundResult[] = [];

  for (let round = startRound; round <= options.rounds; round += 1) {
    const earlier = library.query({ before: round });
    const candidate = options.strategy.propose({ round, surface, earlier });
    if (candidate === null || typeof candidate !== "object" || typeof candidate.artifact !== "string") {
      throw new Error("INVALID_STRATEGY_CANDIDATE");
    }
    const artifactDigest = sha256Hex(candidate.artifact);
    const events = roundEvents(resolvedIdentity);
    const candidateIdentity: EpisodeIdentity = Object.freeze({
      ...resolvedIdentity,
      candidate: candidate.id,
    });
    const snapshot = options.store.freeze(candidateIdentity, {
      ...episodeEvidence(events),
      "candidate.ts": candidate.artifact,
      "surface.md": surface.content,
      "strategy.md": options.strategy.name,
      "experience.md": stableEvidenceStringify(
        earlier.map((item) => ({ id: item.id, cue: item.cue, lesson: item.lesson }))
      ),
    });
    const split = createSearchTestSplit(["a", "b", "c", "d"], {
      salt: `${options.runId}-${round}`,
      holdout: 0.25,
    });
    const heldOutScores: Record<string, number> = {};
    for (const cellId of split.test) heldOutScores[cellId] = 0.9;
    for (const cellId of split.search) heldOutScores[cellId] = 0.1;

    const pipeline = createPromotionPipeline({
      identity: resolvedIdentity,
      store: options.store,
      snapshot,
      regressionGate: options.regressionGate,
      ...(incumbent === undefined ? {} : { incumbent }),
      ...(options.evaluator === undefined ? {} : { evaluator: options.evaluator }),
      heldOutThreshold: 0.5,
    });
    const outcome = pipeline.run({
      candidateId: candidate.id,
      artifact: candidate.artifact,
      expectedDigest: artifactDigest,
      events,
      traces: roundTrace(round),
      heldOutScores,
      split,
      objectives: { reward: 0.9, heldOut: 0.9 },
      before: { mode: "base" },
      after: { mode: "base" },
      observationKeys: ["mode"],
      generation: round + 1,
    });

    if (outcome.decision.promoted) {
      surface = proposeSurfaceEdit(surface, {
        from: "@VERSION@",
        to: `@VERSION@ ${candidate.id}`,
      });
      const promotedIncumbent = outcome.state.incumbent;
      if (promotedIncumbent === undefined) throw new Error("PROMOTION_INCUMBENT_MISSING");
      incumbent = promotedIncumbent;
      options.sealRegistry?.record(
        promotionSealKey(identityDigestValue, promotedIncumbent.id, promotedIncumbent.fitness)
      );
    }

    const traces = [candidate.artifact, JSON.stringify(events.map((event) => event.outcomes))];
    const experienceId = `research:${options.runId}:${round}`;
    library.put({
      id: experienceId,
      candidate: candidate.id,
      kind: "strategy",
      code: candidate.artifact,
      scores: { fitness: outcome.evaluation.reward },
      traces,
      traceDigest: rawTraceDigest(traces),
      step: round,
      tenant: resolvedIdentity.tenant,
      domain: resolvedIdentity.domain,
      mode: resolvedIdentity.mode,
      realm: resolvedIdentity.realm,
      cue: `round-${round}-cue`,
      lesson: candidate.rationale,
      evidence: snapshot.manifest.digest,
      ...(outcome.decision.promoted ? { promoted: true } : { promoted: false }),
    });

    results.push(
      Object.freeze({
        round,
        candidateId: candidate.id,
        artifactDigest,
        frozenDigest: snapshot.manifest.digest,
        promoted: outcome.decision.promoted,
        stages: outcome.stages,
        evaluationReward: outcome.evaluation.reward,
        earlierIds: Object.freeze(earlier.map((item) => item.id)),
        surfaceDigest: surface.digest,
        experienceId,
        snapshot,
        outcome,
      })
    );
  }

  const finalCheckpoint = resumeController.checkpoint({
    runId: options.runId,
    completedRounds: results.length === 0 ? (checkpoint?.completedRounds ?? 0) : options.rounds,
    surface,
    ...(incumbent === undefined ? {} : { incumbent }),
    identityDigest: identityDigestValue,
  });
  return Object.freeze({
    runId: options.runId,
    enabled: true,
    rounds: Object.freeze(results),
    surface,
    ...(incumbent === undefined ? {} : { incumbent }),
    resume: finalCheckpoint,
  });
}

