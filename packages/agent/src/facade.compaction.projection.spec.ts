import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileWorkspaceStore,
  createOffloader,
  RECAP_SEGMENTS,
  resolveCompactionBudget,
} from "@zeta-agent/agent-framework";
import { createAgent, type AgentStreamFn, type AgentStreamChunk } from "./facade";
import { createJsonlSessionStore } from "./session/jsonl-store";
import type { SessionStore } from "./session/store";

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function capturingStream(requests: unknown[]): AgentStreamFn {
  return async function* (request): AsyncIterable<AgentStreamChunk> {
    const messages = (request as { messages?: readonly { content?: unknown }[] }).messages ?? [];
    requests.push(messages.map((message) => String(message.content ?? "")));
    yield { type: "done", stopReason: "stop" };
  };
}

function stubStore(): SessionStore {
  return { append: async () => ({}), appendRecap: async () => ({}) } as unknown as SessionStore;
}

describe("T-18 compaction 投影进入真实 provider 请求", () => {
  test("第二轮请求含 recap 六段 + workspace URI，原块消失且峰值下降", async () => {
    const requests: unknown[] = [];
    const longBlock = `block-alpha-${"x".repeat(4000)}`;
    const agent = createAgent({
      includeBuiltins: false,
      streamFn: capturingStream(requests),
      sessionStore: stubStore(),
      compaction: {
        budget: { totalContextLimit: 10000, compactionThreshold: 1 },
        maxOutputBytes: 512,
      },
    });

    await agent.prompt(longBlock);
    await agent.prompt("block-beta");

    const first = requests[0] as string[];
    const second = requests[1] as string[];
    expect(first.some((item) => item.includes(longBlock))).toBe(true);
    expect(second.some((item) => item.includes("block-alpha"))).toBe(false);
    const joined = second.join("\n");
    expect(joined).toContain("workspace:///");
    for (const segment of RECAP_SEGMENTS) expect(joined).toContain(segment);
    const firstBytes = JSON.stringify(first).length;
    const secondBytes = JSON.stringify(second).length;
    expect(secondBytes).toBeLessThan(firstBytes);
    expect(agent.compaction?.budgetTracker.peak).toBeGreaterThan(0);
  });

  test("objective 逐字保真；maxOutputBytes 绑定外置块且阈值联动", async () => {
    const requests: unknown[] = [];
    const objective = "Recover the exact objective string verbatim: Ω-42";
    const compacted: Array<{ objective: string }> = [];
    const agent = createAgent({
      includeBuiltins: false,
      systemPrompt: objective,
      streamFn: capturingStream(requests),
      sessionStore: {
        append: async () => ({}),
        appendRecap: async (recap: unknown) => {
          compacted.push({ objective: (recap as { objective: string }).objective });
          return {};
        },
      } as unknown as SessionStore,
      compaction: {
        budget: { totalContextLimit: 10000, compactionThreshold: 4000 },
        mode: "SAC",
        maxOutputBytes: 10000,
      },
    });

    await agent.prompt(objective);
    const recapMessage = (requests[0] as string[]).find((item) => item.startsWith("You are zeta")) ?? "";
    // 首轮不含 recap；objective 在压缩血缘与下一轮请求中逐字出现。
    expect(recapMessage).not.toContain("Compacted conversation recap");
    expect(compacted[0]?.objective).toBe(objective);

    await agent.prompt("next turn");
    const second = (requests[1] as string[]).join("\n");
    expect(second).toContain(objective);
    expect(second).toContain("objective: " + objective);

    // SAC 与 maxOutputBytes 联动：满额输出占用把阈值压到 1（每动作压缩）。
    expect(resolveCompactionBudget({
      totalContextLimit: 10000,
      compactionThreshold: 4000,
      mode: "SAC",
      maxOutputBytes: 10000,
    }).compactionThreshold).toBe(1);
  });

  test("workspace URI 跨 agent 重启仍可取回，不是内存态", async () => {
    const root = join(tempDir("zeta-t18-workspace-"), "blocks");
    mkdirSync(root, { recursive: true });
    const sessionPath = join(tempDir("zeta-t18-session-"), "session.jsonl");
    const uris: string[] = [];
    const store1 = createJsonlSessionStore({ path: sessionPath });
    const agent1 = createAgent({
      includeBuiltins: false,
      streamFn: capturingStream([]),
      sessionStore: store1,
      compaction: {
        budget: { totalContextLimit: 10000, compactionThreshold: 1 },
        workspaceStorePath: root,
        maxOutputBytes: 4096,
      },
    });
    await agent1.prompt("durable-block-Ω");
    uris.push(...(agent1.compaction!.surface.lineage()[0]?.uris ?? []));
    expect(uris.length).toBeGreaterThan(0);
    expect(uris[0]).toMatch(/^workspace:\/\/\//);

    // 新进程等价：全新的 WorkspaceStore / Offloader / SessionStore 实例指向同一目录。
    const reopenedStore = createFileWorkspaceStore({ root });
    const reopenedOffloader = createOffloader(reopenedStore);
    const retrieved = await reopenedOffloader.retrieve<unknown>(uris[0]!);
    const reopenedSession = createJsonlSessionStore({ path: sessionPath });
    expect(retrieved).toBeDefined();
    expect(JSON.stringify(retrieved)).toContain("durable-block-Ω");
    expect(reopenedSession.projection().lineage.length).toBeGreaterThan(0);

    const agent2 = createAgent({
      includeBuiltins: false,
      streamFn: capturingStream([]),
      sessionStore: reopenedSession,
      compaction: {
        budget: { totalContextLimit: 10000, compactionThreshold: 1 },
        workspaceStorePath: root,
      },
    });
    expect(agent2.compaction?.surface.entries().length).toBeGreaterThan(0);
  });
});
