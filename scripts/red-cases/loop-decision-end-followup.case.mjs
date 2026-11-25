import { createEventStream } from "../../packages/agent-framework/src/runtime/agent.ts";
import { createInbox } from "../../packages/agent-framework/src/runtime/inbox.ts";
import { runLoop } from "../../packages/agent-framework/src/runtime/loop.ts";
import { green, red } from "./common.mjs";

const EVIDENCE =
  "packages/agent-framework/src/runtime/loop.ts:313-318（shouldEnd 分支在有 followUp 时 enterInner=true 回到内层循环）";

export default {
  id: "RED-01-loop-decision-end-followup",
  title: "decision end + 预置 follow-up 后不能再请求 provider",
  expectation: "streamAssistant 调用次数为 1：decision end 立即终结本轮，预置 follow-up 不得被同一次 run 偷偷消费",
  target: "AC-06",
  async probe() {
    const inbox = createInbox();
    const stream = createEventStream();
    let calls = 0;
    inbox.followUp({ role: "user", content: "preset-followup" });

    await runLoop({
      inbox,
      emit: (event) => stream.emit(event),
      getState: () => stream.getState(),
      decision: () => ({ kind: "exit", reason: "decision-end" }),
      streamAssistant: async () => {
        calls += 1;
        return {
          message: { role: "assistant", content: `r${calls}` },
          toolCalls: [],
          stopReason: "stop",
        };
      },
    });

    const actual = { streamAssistantCalls: calls, followUpConsumed: inbox.size("followUp") === 0 };
    return calls === 1
      ? green(actual, EVIDENCE)
      : red(
          actual,
          `decision 返回 exit 后仍发起了 ${calls} 次 provider 请求（期望 1 次）；follow-up 在 shouldEnd 分支被立即 poll 并重新进入内层循环`,
          EVIDENCE
        );
  },
};
