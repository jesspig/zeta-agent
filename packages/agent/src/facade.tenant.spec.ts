import { describe, expect, test } from "bun:test";
import { createAuditSink, type AuditSink } from "@zeta-agent/security";
import type { AgentStreamChunk, AgentStreamRequest } from "./facade";
import { createAgent } from "./facade";
import { createDurableEffects, type DurableEffects } from "./plugins/effects/durable";
import type { SessionStore } from "./session/store";
import { createExperienceStore } from "./research/experience";
import { createTenantGovernance } from "./tenant/governance";

const freshResearch = () => createExperienceStore();

function toolHarness(options: {
  readonly scope: ReturnType<ReturnType<typeof createTenantGovernance>["resolve"]>;
  readonly auditSink?: AuditSink;
  readonly stream?: () => AsyncIterable<AgentStreamChunk>;
}) {
  let turn = 0;
  const streamFn = options.stream ?? (async function* (): AsyncIterable<AgentStreamChunk> {
    turn += 1;
    if (turn === 1) {
      yield { type: "tool_call", id: "c1", name: "emit", arguments: JSON.stringify({ value: "x" }) };
      return;
    }
    yield "done";
  });
  const executed: string[] = [];
  const agent = createAgent({
    includeBuiltins: false,
    emissionTools: ["emit"],
    tenantScope: options.scope,
    auditSink: options.auditSink,
    streamFn,
  });
  agent.api.registerTool({
    name: "emit",
    description: "emit",
    parameters: [],
    execute: () => {
      executed.push("emit");
      return "EXECUTED";
    },
  } as never);
  return { agent, executed };
}

describe("T-13 facade principal/resource/quota 注入", () => {
  test("withhold 前先 reserve：发射消耗 realm 配额且只派发一次", async () => {
    const dispatched: string[] = [];
    const effects = createDurableEffects((intent) => {
      dispatched.push(intent.key);
      return "DISPATCHED";
    });
    const governance = createTenantGovernance({
      createExperienceStore: freshResearch,
      tokensPerTenant: 2,
      createDurableEffects: () => effects,
    });
    const scope = governance.resolve({ spaceId: "quota-ok" });
    const { agent, executed } = toolHarness({ scope });

    await agent.prompt("go");
    expect(executed).toEqual([]);
    expect(scope.quota.remaining()).toBe(1);
    expect(dispatched).toHaveLength(1);
    expect(effects.receipts()).toHaveLength(1);
    await governance.dispose();
  });

  test("配额耗尽时拒绝发射：不入队、不派发并写 QUOTA_DENIED 审计", async () => {
    const dispatched: string[] = [];
    const effects = createDurableEffects((intent) => {
      dispatched.push(intent.key);
      return "DISPATCHED";
    });
    const governance = createTenantGovernance({
      createExperienceStore: freshResearch,
      tokensPerTenant: 1,
      createDurableEffects: () => effects,
    });
    const scope = governance.resolve({ spaceId: "quota-full" });
    expect(scope.quota.reserve(1)).toBe(true);
    expect(scope.quota.remaining()).toBe(0);
    const auditSink = createAuditSink();
    const { agent, executed } = toolHarness({ scope, auditSink });

    await agent.prompt("go");
    expect(executed).toEqual([]);
    expect(dispatched).toEqual([]);
    expect(effects.receipts()).toHaveLength(0);
    expect(scope.quota.remaining()).toBe(0);
    expect(auditSink.entries.some((entry) => entry.record.decision === "QUOTA_DENIED")).toBe(true);
    await governance.dispose();
  });

  test("principal 注入审计：AuditRecord.tenant 来自 realm 的 spaceId", async () => {
    const governance = createTenantGovernance({ createExperienceStore: freshResearch });
    const scope = governance.resolve({ spaceId: "audit-tenant", userId: "user-1" });
    const auditSink = createAuditSink();
    const { agent } = toolHarness({ scope, auditSink });

    await agent.prompt("go");
    expect(auditSink.entries.length).toBeGreaterThan(0);
    expect(auditSink.entries.every((entry) => entry.record.tenant === "audit-tenant")).toBe(true);
    expect(agent.tenantScope).toBe(scope);
    await governance.dispose();
  });

  test("双租户并发：provider/session/effects 按 realm 解析且互不串", async () => {
    const streamCalls: string[] = [];
    const appends: Record<string, unknown[]> = { a: [], b: [] };
    const effectCalls: Record<string, string[]> = { a: [], b: [] };
    const sessionStores: Record<string, SessionStore> = {};
    const effectsBySpace: Record<string, DurableEffects> = {};
    const governance = createTenantGovernance({
      createExperienceStore: freshResearch,
      tokensPerTenant: 5,
      createSessionStore: (principal) => {
        const tag = principal.spaceId;
        const store = {
          append: async (message: unknown) => {
            appends[tag === "space-a" ? "a" : "b"]?.push(message);
            return { frameId: `${tag}-frame`, seq: 1, outcome: "committed" as const };
          },
          close: () => {},
        } as unknown as SessionStore;
        sessionStores[tag] = store;
        return store;
      },
      createDurableEffects: (principal) => {
        const tag = principal.spaceId;
        const effects = createDurableEffects((intent) => {
          effectCalls[tag === "space-a" ? "a" : "b"]?.push(intent.key);
          return tag;
        });
        effectsBySpace[tag] = effects;
        return effects;
      },
      createStreamFn: (principal) => {
        const tag = principal.spaceId;
        return async function* (): AsyncIterable<AgentStreamChunk> {
          streamCalls.push(tag);
          yield `${tag}-done`;
        };
      },
    });
    const scopeA = governance.resolve({ spaceId: "space-a" });
    const scopeB = governance.resolve({ spaceId: "space-b" });
    const agentA = createAgent({ includeBuiltins: false, tenantScope: scopeA, streamFn: scopeA.streamFn });
    const agentB = createAgent({ includeBuiltins: false, tenantScope: scopeB, streamFn: scopeB.streamFn });
    agentA.api.registerTool({
      name: "emit",
      description: "emit",
      parameters: [],
      execute: () => "A",
    } as never);
    agentB.api.registerTool({
      name: "emit",
      description: "emit",
      parameters: [],
      execute: () => "B",
    } as never);

    await Promise.all([agentA.prompt("a"), agentB.prompt("b")]);
    expect(streamCalls.sort()).toEqual(["space-a", "space-b"]);
    expect(scopeA.sessionStore).toBe(sessionStores["space-a"]);
    expect(scopeB.sessionStore).toBe(sessionStores["space-b"]);
    expect(scopeA.sessionStore).not.toBe(scopeB.sessionStore);
    expect(appends["a"]?.length ?? 0).toBeGreaterThan(0);
    expect(appends["b"]?.length ?? 0).toBeGreaterThan(0);
    expect(effectsBySpace["space-a"]).not.toBe(effectsBySpace["space-b"]);
    expect(scopeA.durableEffects).toBe(effectsBySpace["space-a"]);
    expect(scopeB.durableEffects).toBe(effectsBySpace["space-b"]);
    expect(scopeA.research).not.toBe(scopeB.research);
    await governance.dispose();
  });
});
