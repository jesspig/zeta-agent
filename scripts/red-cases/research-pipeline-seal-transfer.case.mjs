import { episodeEvidence } from "../../packages/agent/src/research/decision.ts";
import { createSearchTestSplit } from "../../packages/agent/src/research/fitness.ts";
import { createEpisodeIdentity, createFrozenStore } from "../../packages/agent/src/research/frozen.ts";
import {
  createPromotionState,
  promote,
  sha256Hex,
} from "../../packages/agent/src/research/promotion.ts";
import {
  createPromotionPipeline,
  createRegressionGate,
} from "../../packages/agent/src/research/pipeline.ts";
import { green, red } from "./common.mjs";

const EVIDENCE =
  "packages/agent/src/research/promotion.ts:66-89,118-120（promote 只验 seal 合法性，不校验授权是否已消费/绑定 pipeline）；pipeline.spec.ts:299-305 当前断言复用不抛错";

function identity() {
  return createEpisodeIdentity({
    run: "red-run",
    task: "red-task",
    tenant: "red-tenant",
    domain: "coding",
    mode: "live",
  });
}

function outcome(cellId, score) {
  return { cellId, score, valid: true, failed: false };
}

function events() {
  const id = identity();
  return [
    {
      identity: id,
      before: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
      batch: [{ kind: "probe", cellId: "a" }, { kind: "probe", cellId: "b" }],
      parallelism: 2,
      outcomes: [outcome("a", 0.6), outcome("b", 0.4)],
      after: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
    },
  ];
}

export default {
  id: "RED-04-research-pipeline-seal-transfer",
  title: "pipeline 签发的晋升授权不能被低阶 promote 复用",
  expectation: "pipeline 已消费的候选 seal 再交给裸 promote() 时必须拒绝（授权不可转移/不可重放）",
  target: "AC-21",
  async probe() {
    const id = identity();
    const store = createFrozenStore();
    const snapshot = store.freeze(id, episodeEvidence(events()));
    const split = createSearchTestSplit(["a", "b", "c", "d"], { salt: "s", holdout: 0.25 });
    const heldOutScores = {};
    for (const cellId of split.test) heldOutScores[cellId] = 0.9;
    for (const cellId of split.search) heldOutScores[cellId] = 0.1;
    const artifact = "const next = 1 + 1;";
    const pipeline = createPromotionPipeline({
      identity: id,
      store,
      snapshot,
      regressionGate: createRegressionGate({ run: () => true }),
      heldOutThreshold: 0.5,
    });
    const issued = pipeline.run({
      candidateId: "red-candidate",
      artifact,
      expectedDigest: sha256Hex(artifact),
      events: events(),
      traces: [
        {
          name: "t1",
          runBest: 1,
          nEvaluated: 2,
          points: [
            { budget: 1, best: 0.25, sequentialRounds: 1 },
            { budget: 3, best: 0.75, sequentialRounds: 2 },
          ],
        },
      ],
      heldOutScores,
      split,
      objectives: { reward: 0.9, heldOut: 0.9 },
      before: { mode: "base" },
      after: { mode: "base" },
      observationKeys: ["mode"],
      generation: 2,
    });

    const candidate = issued.candidate;
    let reused = false;
    let error = "";
    try {
      const again = promote(createPromotionState(), candidate);
      reused = again.incumbent?.id === candidate.id;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    const actual = {
      pipelinePromoted: issued.decision.promoted,
      candidateId: candidate.id,
      sealKind: candidate.seal?.kind,
      lowLevelPromoteReused: reused,
      error,
    };

    return !reused
      ? green(actual, EVIDENCE)
      : red(
          actual,
          "pipeline 已签发并消费的 candidate 被裸 promote() 再次晋升成功：seal 只证明格式合法，未绑定单次授权，违反‘晋升授权不可转移’",
          EVIDENCE
        );
  },
};
