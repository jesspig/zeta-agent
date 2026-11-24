import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "../runtime/agent";
import type { SurfaceEntry } from "./surface";
import { classifyRecap, groupEntries, messageBoundaryTail, safeCutIndex } from "./recap";

const msg = (message: AgentMessage): SurfaceEntry => ({ kind: "message", message });

function toolPair(): SurfaceEntry[] {
  return [
    msg({ role: "system", content: "SHIP IT" }),
    msg({ role: "assistant", content: "editing", toolCalls: [{ id: "c1", name: "edit", arguments: '{"path":"a.ts"}' }] }),
    msg({ role: "toolResult", content: "done", toolCallId: "c1", toolName: "edit" }),
    msg({ role: "user", content: "now verify" }),
    msg({ role: "assistant", content: "checking", toolCalls: [{ id: "c2", name: "bash", arguments: '{"cmd":"bun test"}' }] }),
    msg({ role: "toolResult", content: "pass", toolCallId: "c2", toolName: "bash" }),
  ];
}

describe("T-12 typed recap 分类", () => {
  test("system 逐字进入 objective，成功工具输出为 observation", () => {
    const recap = classifyRecap(toolPair(), ["workspace:///a"]);
    expect(recap.objective).toBe("SHIP IT");
    expect(recap.establishedFacts.some((f) => f.text === "done" && f.kind === "observation")).toBe(true);
  });

  test("用户/助手正文标 unverified，不提升为 observation", () => {
    const recap = classifyRecap(toolPair(), []);
    expect(recap.establishedFacts.some((f) => f.text === "now verify" && f.kind === "unverified")).toBe(true);
    expect(recap.establishedFacts.filter((f) => f.kind === "observation").some((f) => f.text === "now verify")).toBe(false);
  });

  test("edit 工具成功落到 appliedChanges 且 verified，检查命令落到 verification", () => {
    const recap = classifyRecap(toolPair(), []);
    expect(recap.appliedChanges.some((c) => c.file === "a.ts" && c.verified)).toBe(true);
    expect(recap.verification.some((v) => v.check === "bash" && v.result === "pass")).toBe(true);
  });

  test("失败工具结果落到 deadEnds；URI 落到 remainingPlan", () => {
    const entries = [
      msg({ role: "system", content: "x" }),
      msg({ role: "toolResult", content: "ECONNREFUSED", toolCallId: "c3", toolName: "bash", isError: true } as AgentMessage),
    ];
    const recap = classifyRecap(entries, ["workspace:///z"]);
    expect(recap.deadEnds.some((d) => d.includes("ECONNREFUSED"))).toBe(true);
    expect(recap.remainingPlan.some((p) => p.includes("workspace:///z"))).toBe(true);
  });
});

describe("T-12 安全切点与完整消息边界", () => {
  test("groupEntries 把 assistant 工具调用与其 toolResult 合成一组", () => {
    const groups = groupEntries(toolPair());
    const pair = groups.find((g) => g.entries.some((e) => e.kind === "message" && e.message.role === "assistant" && (e.message as AgentMessage).toolCalls !== undefined));
    expect(pair).toBeDefined();
    expect(pair!.entries.length).toBe(2);
  });

  test("safeCutIndex 不切断 tool pair", () => {
    const entries = toolPair();
    const cut = safeCutIndex(entries, 2);
    expect(cut).toBe(3); // system + assistant/edit + toolResult
    const cutForVerify = safeCutIndex(entries, 5);
    expect(cutForVerify).toBe(6);
  });

  test("messageBoundaryTail 返回的后缀从完整组开始，不拆工具对", () => {
    const entries = toolPair();
    const tail = messageBoundaryTail(entries, 3);
    expect(tail.length).toBe(3);
    const roles = tail.map((e) => (e.kind === "message" ? e.message.role : "recap"));
    expect(roles).toEqual(["user", "assistant", "toolResult"]);
    // 左边界落在 user 组（完整消息），随后的 assistant+toolResult 工具对不被拆开
    const assistant = tail[1];
    expect(assistant?.kind === "message" && (assistant.message as AgentMessage).toolCalls).toBeDefined();
    expect(tail[2]?.kind === "message" && (tail[2].message as AgentMessage).toolCallId).toBe("c2");
  });
});
