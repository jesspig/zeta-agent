import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../../packages/agent/src/facade.ts";
import { createJsonlSessionStore } from "../../packages/agent/src/session/jsonl-store.ts";
import { green, red, text } from "./common.mjs";

const EVIDENCE =
  "packages/agent/src/facade.ts:611-621（createAgent 只订阅 agent_end 写 store，无恢复路径），:1302-1304（空 state 时直接返回）";

export default {
  id: "RED-05-session-agent-restore",
  title: "新 Agent 从同一 SessionStore 恢复后应看到上次消息",
  expectation: "第二个 createAgent({ sessionStore }) 的 state.messages 包含上次的 'restore-marker' 用户消息",
  target: "AC-09",
  async probe() {
    const dir = mkdtempSync(join(tmpdir(), "zeta-red-session-"));
    try {
      const store = createJsonlSessionStore({
        path: join(dir, "session.jsonl"),
        sessionId: "red-restore-session",
      });
      const streamFn = async function* () {
        yield "ok";
      };
      const first = createAgent({ includeBuiltins: false, streamFn, sessionStore: store });
      await first.prompt("restore-marker");
      const persisted = store.projection().messages.map((message) => text(message.content));

      const second = createAgent({ includeBuiltins: false, streamFn, sessionStore: store });
      const restored = second.state.messages.map((message) => text(message.content));
      store.close();

      const actual = { persisted, restored, restoredCount: restored.length };
      return restored.some((item) => item.includes("restore-marker"))
        ? green(actual, EVIDENCE)
        : red(
            actual,
            "store 中已有 'restore-marker'，但新 Agent 的 state.messages 为空：createAgent 只追加不恢复，transcript/system/tool 无法跨 Agent 复用",
            EVIDENCE
          );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};
