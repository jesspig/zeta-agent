import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentStreamChunk, AgentStreamRequest } from "./facade";
import { createAgent } from "./facade";
import {
  createDurableEffects,
  type DurableEffects,
  type DurableIntent,
} from "./plugins/effects/durable";
import {
  createAuditSink,
  createCredentialVault,
  createEgressPolicy,
  verifyAuditChain,
  type AuditSink,
  type EgressPolicy,
} from "@zeta-agent/security";

/** 与 @zeta-agent/security 默认审计哈希一致（FNV-1a 32）。 */
function auditHash(input: string): string {
  let value = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    value ^= input.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return (value >>> 0).toString(16);
}

function sse(frames: readonly string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function collect(iterable: AsyncIterable<unknown>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of iterable) {
    if (typeof chunk === "string") out.push(chunk);
    else if (typeof chunk === "object" && chunk !== null && "text" in chunk) {
      const text = (chunk as { text?: unknown }).text;
      if (typeof text === "string") out.push(text);
    }
  }
  return out;
}

interface ToolCallArgs {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

interface EmissionHarness {
  readonly agent: ReturnType<typeof createAgent>;
  readonly dispatched: () => readonly DurableIntent[];
  readonly executions: () => number;
  readonly events: readonly AgentEvent[];
}

/** 首回合发出给定的 tool_call 批次，次回合文本收束，避免自动续跑失控。 */
function emissionHarness(options: {
  readonly calls: readonly ToolCallArgs[];
  readonly emissionTools?: readonly string[];
  readonly egressPolicy?: EgressPolicy;
  readonly effects?: DurableEffects;
  readonly auditSink?: AuditSink;
  readonly auditDir?: string;
}): EmissionHarness {
  const dispatched: DurableIntent[] = [];
  /** 记录每次 dispatch 发生时已派发数量：首条必须为 0，才能证明 commit 前无副作用。 */
  const dispatchDepth: number[] = [];
  const effects = options.effects ?? createDurableEffects((intent) => {
    dispatchDepth.push(dispatched.length);
    dispatched.push(intent);
    return "DISPATCHED";
  });
  let turn = 0;
  let executions = 0;
  const agent = createAgent({
    includeBuiltins: false,
    durableEffects: effects,
    egressPolicy: options.egressPolicy,
    emissionTools: options.emissionTools ?? [],
    auditSink: options.auditSink,
    auditDir: options.auditDir,
    streamFn: async function* (): AsyncIterable<AgentStreamChunk> {
      turn += 1;
      if (turn === 1) {
        for (const [index, call] of options.calls.entries()) {
          yield {
            type: "tool_call",
            id: `c${index + 1}`,
            name: call.name,
            arguments: JSON.stringify(call.args),
          };
        }
        return;
      }
      yield "done";
    },
  });
  for (const name of new Set(options.calls.map((call) => call.name))) {
    agent.api.registerTool({
      name,
      description: name,
      parameters: [],
      execute: () => {
        executions += 1;
        return "EXECUTED";
      },
    } as never);
  }
  const events: AgentEvent[] = [];
  agent.subscribe((event) => { events.push(event); });
  return { agent, dispatched: () => [...dispatched], executions: () => executions, events };
}

describe("T-06 安全组件接入真实工具/provider 路径（系统级证据）", () => {
  test("① withhold：commit 前无副作用，commit 后恰好派发一次", async () => {
    const dispatched: DurableIntent[] = [];
    const depthAtDispatch: number[] = [];
    const effects = createDurableEffects((intent) => {
      depthAtDispatch.push(dispatched.length);
      dispatched.push(intent);
      return "DISPATCHED";
    });
    const harness = emissionHarness({
      calls: [{ name: "emit", args: { url: "https://sink.test/notify" } }],
      emissionTools: ["emit"],
      egressPolicy: createEgressPolicy({ allow: [{ host: "sink.test", port: 443 }] }),
      effects,
    });

    // prompt 之前：尚未 enqueue，更没有真实副作用。
    expect(effects.pending()).toHaveLength(0);
    expect(dispatched).toHaveLength(0);

    await harness.agent.prompt("go");

    // 批次内只有 enqueue；真实工具 execute 从未被调用。
    expect(harness.executions()).toBe(0);
    // dispatch 首次发生时已派发数为 0（commit 之前没有任何副作用），且总共恰好一次。
    expect(depthAtDispatch).toEqual([0]);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.kind).toBe("emit");
    expect(dispatched[0]?.key).toMatch(/^emit:/);
    expect(effects.receipts()).toHaveLength(1);
    expect(harness.agent.emissionReceipts()).toHaveLength(1);
  });

  test("② 重复 (kind,key) 不重复派发（进程内幂等）", async () => {
    const args = { url: "https://sink.test/same" };
    const harness = emissionHarness({
      calls: [
        { name: "emit", args },
        { name: "emit", args: { ...args } },
        { name: "emit", args: { url: "https://sink.test/other" } },
      ],
      emissionTools: ["emit"],
      egressPolicy: createEgressPolicy({ allow: [{ host: "sink.test", port: 443 }] }),
    });

    await harness.agent.prompt("go");

    expect(harness.executions()).toBe(0);
    // 三条工具调用、两个不同的 key → 只派发两个不同意图。
    expect(harness.dispatched()).toHaveLength(2);
    expect(new Set(harness.dispatched().map((intent) => intent.key)).size).toBe(2);
    expect(harness.agent.emissionReceipts()).toHaveLength(2);
  });

  test("③ egress 拒绝时不派发，允许时正常派发", async () => {
    const egressPolicy = createEgressPolicy({
      allow: [{ host: "allowed.test", port: 443 }],
    });
    const blocked = emissionHarness({
      calls: [{ name: "emit", args: { url: "https://blocked.test/notify" } }],
      emissionTools: ["emit"],
      egressPolicy,
    });
    await blocked.agent.prompt("go");
    expect(blocked.dispatched()).toHaveLength(0);
    expect(blocked.executions()).toBe(0);
    const failed = blocked.agent.emissionReceipts().filter((receipt) => !receipt.ok);
    expect(failed).toHaveLength(1);
    expect(JSON.stringify(failed[0])).toContain("EGRESS_DENIED");

    const allowed = emissionHarness({
      calls: [{ name: "emit", args: { url: "https://allowed.test/notify" } }],
      emissionTools: ["emit"],
      egressPolicy,
    });
    await allowed.agent.prompt("go");
    expect(allowed.dispatched()).toHaveLength(1);
    expect(allowed.executions()).toBe(0);
  });

  test("④ provider 请求不含明文 key，占位符在 fetch 边界解析注入", async () => {
    const SECRET = "sk-real-secret-abcdef";
    const logs: string[] = [];
    const vault = createCredentialVault();
    const bindings: Array<{ readonly host: string; readonly scheme: string }> = [];
    const broker = (binding: { readonly host: string; readonly scheme: string }): Record<string, string> => {
      bindings.push({ host: binding.host, scheme: binding.scheme });
      return { Authorization: `Bearer ${SECRET}` };
    };
    const agent = createAgent({
      includeBuiltins: false,
      credentialVault: vault,
      secretBroker: broker,
      observability: { runId: "cred", sink: (message) => logs.push(message.message) },
    });

    let captured: { url: string; headers: Headers } | undefined;
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), headers: new Headers(init?.headers) };
      return sse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', "data: [DONE]\n\n"]);
    }) as unknown as typeof fetch;
    const baseUrl = "https://api.example.test/v1";
    const streamFn = agent.createProviderStreamFn(
      { provider: "groq", model: "llama", baseUrl },
      fakeFetch
    );
    const request: AgentStreamRequest = { messages: [{ role: "user", content: "hi" }] };
    expect(await collect(streamFn(request))).toEqual(["ok"]);

    const placeholder = vault.issued[0];
    expect(placeholder).toBeDefined();
    expect(placeholder?.token).toContain("__zeta_secret_");
    expect(placeholder?.token).not.toContain(SECRET);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toEqual({ host: "api.example.test", scheme: "https" });

    // 边界前的构造对象不含明文：请求 URL 无明文，日志无明文。
    expect(captured?.url).not.toContain(SECRET);
    expect(logs.join("\n")).not.toContain(SECRET);
    // 边界处真实凭据确实被注入到 header（占位符解析生效）。
    expect(captured?.headers.get("Authorization")).toBe(`Bearer ${SECRET}`);

    // 对照：同一占位符直接构造 provider 请求时，header 只含占位符，明文不进入请求构造层。
    let preBoundaryHeader = "";
    const plainFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      preBoundaryHeader = new Headers(init?.headers).get("Authorization") ?? "";
      return sse(["data: [DONE]\n\n"]);
    }) as unknown as typeof fetch;
    const { createProviderStreamFn } = await import("./providers/dispatch");
    await collect(createProviderStreamFn(
      { provider: "groq", model: "llama", baseUrl, apiKey: placeholder!.token },
      plainFetch
    )(request));
    expect(preBoundaryHeader).toBe(`Bearer ${placeholder!.token}`);
    expect(preBoundaryHeader).not.toContain(SECRET);
  });

  test("⑤ audit finalize 不再写无签名旁路文件，链仍可校验", async () => {
    const auditDir = mkdtempSync(join(tmpdir(), "zeta-audit-"));
    try {
      const auditSink = createAuditSink();
      const harness = emissionHarness({
        calls: [
          { name: "emit", args: { url: "https://allowed.test/notify" } },
          { name: "plain", args: { value: 1 } },
        ],
        emissionTools: ["emit"],
        egressPolicy: createEgressPolicy({ allow: [{ host: "allowed.test", port: 443 }] }),
        auditSink,
        auditDir,
      });
      await harness.agent.prompt("go");

      const revision = auditSink.entries.length;
      expect(revision).toBeGreaterThan(0);
      const result = harness.agent.finalizeAudit(revision);
      expect(result.configured).toBe(true);
      expect(result.finalized).toBe("complete");
      expect(result.entries).toBe(revision);
      expect(result.verified).toBe(true);
      expect(result.path).toBeUndefined();
      expect(readdirSync(auditDir)).toHaveLength(0);
      expect(verifyAuditChain(auditSink.entries, auditHash)).toBe(true);

      const decisions = auditSink.entries.map((entry) => entry.record.decision);
      expect(decisions).toContain("EMISSION_WITHHELD");
      expect(decisions).toContain("EMISSION_DISPATCHED");
      expect(decisions).toContain("TOOL_EXECUTED");
    } finally {
      rmSync(auditDir, { recursive: true, force: true });
    }
  });

  test("⑥ 不注入任何新选项时行为与基线一致", async () => {
    let turn = 0;
    let executions = 0;
    const calls: string[] = [];
    const agent = createAgent({
      includeBuiltins: false,
      streamFn: async function* (): AsyncIterable<AgentStreamChunk> {
        turn += 1;
        if (turn === 1) {
          yield { type: "tool_call", id: "c1", name: "plain", arguments: "{}" };
          return;
        }
        yield "done";
      },
    });
    agent.api.registerTool({
      name: "plain",
      description: "plain",
      parameters: [],
      execute: () => {
        executions += 1;
        return "OK";
      },
    } as never);
    agent.api.addBeforeToolCall(() => { calls.push("before"); });
    agent.api.addAfterToolCall(() => { calls.push("after"); });
    const events: AgentEvent[] = [];
    agent.subscribe((event) => { events.push(event); });

    await agent.prompt("go");

    expect(executions).toBe(1);
    expect(calls).toEqual(["before", "after"]);
    const ends = events.filter((event) => event.type === "tool_execution_end");
    expect(ends).toHaveLength(1);
    expect(ends[0]?.result).toBe("OK");
    expect(agent.emissionReceipts()).toEqual([]);
    expect(agent.finalizeAudit(0)).toEqual({
      configured: false,
      finalized: "not-configured",
      entries: 0,
      verified: false,
    });

    // 注入 effects 但 emissionTools 为空（默认）时仍然走原路径，不 withhold。
    const harness = emissionHarness({
      calls: [{ name: "plain", args: {} }],
      emissionTools: [],
    });
    await harness.agent.prompt("go");
    expect(harness.executions()).toBe(1);
    expect(harness.dispatched()).toHaveLength(0);
  });
});
