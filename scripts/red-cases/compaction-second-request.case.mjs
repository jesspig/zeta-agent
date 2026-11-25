import { createAgent } from "../../packages/agent/src/facade.ts";
import { green, red, text } from "./common.mjs";

const EVIDENCE =
  "packages/agent/src/facade.ts:1565-1580（prepareRequest 只注入 system + 外部 transform，不投影 compaction surface）；:718-740（compaction 仅在 agent_end 写 surface/血缘）";

export default {
  id: "RED-06-compaction-second-request",
  title: "第二轮 provider 请求应包含 recap 且旧块被替换",
  expectation: "第二轮请求的 messages 含 recap 投影（workspace:/// 或 recap 六段标记），且不再含原样旧块 block-alpha",
  target: "AC-18",
  async probe() {
    const requests = [];
    const streamFn = async function* (request) {
      requests.push((request.messages ?? []).map((message) => text(message?.content)));
      yield { type: "done", stopReason: "stop" };
    };
    const lineage = [];
    const sessionStore = {
      append: async () => ({}),
      appendRecap: async (recap, uris) => {
        lineage.push({ recap, uris });
        return {};
      },
    };
    const agent = createAgent({
      includeBuiltins: false,
      streamFn,
      sessionStore,
      compaction: { budget: { totalContextLimit: 10000, compactionThreshold: 1 } },
    });

    await agent.prompt("block-alpha");
    await agent.prompt("block-beta");

    const surfaceEntries = agent.compaction?.surface.entries() ?? [];
    const compacted = surfaceEntries.some((entry) => entry.kind === "recap");
    const second = requests[1] ?? [];
    const joined = second.join("\n");
    const includesRecap = joined.includes("workspace:///") || joined.includes("establishedFacts");
    const oldBlockReplaced = !second.some((item) => item.includes("block-alpha"));
    const actual = {
      compacted,
      lineageCount: lineage.length,
      secondRequestMessageCount: second.length,
      secondRequestHasBlockAlpha: second.some((item) => item.includes("block-alpha")),
      secondRequestHasRecapMarker: includesRecap,
      oldBlockReplaced,
    };

    return compacted && includesRecap && oldBlockReplaced
      ? green(actual, EVIDENCE)
      : red(
          actual,
          "压缩只在 agent_end 改了 surface，prepareRequest 未投影 recap：第二轮请求仍是原始 transcript（含 block-alpha），没有 workspace:/// 或 recap 六段",
          EVIDENCE
        );
  },
};
