import { describe, expect, test } from "bun:test";
import type { AgentStreamChunk, AgentStreamFn } from "../facade";
import { createTenantGovernance } from "../tenant/governance";
import { createDefaultRuntime } from "./runtime";

function stubStream(): AgentStreamFn {
  return async function* (): AsyncIterable<AgentStreamChunk> {
    yield "ok";
  };
}

describe("T-13 统一装配注入 principal 与 realm 作用域", () => {
  test("principalInput 解析租户作用域并注入 agent/session", async () => {
    const governance = createTenantGovernance({ tokensPerTenant: 2 });
    const runtime = await createDefaultRuntime({
      includeBuiltins: false,
      streamFn: stubStream(),
      principalInput: { spaceId: "runtime-a", userId: "user-a" },
      tenantGovernance: governance,
    });

    expect(runtime.tenantScope?.principal.spaceId).toBe("runtime-a");
    expect(runtime.agent.tenantScope).toBe(runtime.tenantScope);
    expect(runtime.tenantScope?.quota.capacity).toBe(2);
    const result = await runtime.protocol.dispatch({ type: "control", action: "prompt", text: "tenant-run" });
    expect(result.ok).toBe(true);
    await runtime.dispose();
    // 外部注入的 governance 由调用方持有：runtime.dispose 不得连带销毁兄弟 realm。
    expect(governance.scopes.has(runtime.tenantScope!.realm)).toBe(true);
    await governance.dispose();
  });

  test("双租户 runtime 并发：provider/session 按 realm 解析，dispose 不影响兄弟", async () => {
    const streams: string[] = [];
    const governance = createTenantGovernance({
      tokensPerTenant: 3,
      createStreamFn: (principal) => async function* (): AsyncIterable<AgentStreamChunk> {
        streams.push(principal.spaceId);
        yield `${principal.spaceId}-ok`;
      },
    });
    const runA = await createDefaultRuntime({
      includeBuiltins: false,
      principalInput: { spaceId: "space-a" },
      tenantGovernance: governance,
    });
    const runB = await createDefaultRuntime({
      includeBuiltins: false,
      principalInput: { spaceId: "space-b" },
      tenantGovernance: governance,
    });

    await Promise.all([
      runA.protocol.dispatch({ type: "control", action: "prompt", text: "a" }),
      runB.protocol.dispatch({ type: "control", action: "prompt", text: "b" }),
    ]);
    expect(streams.sort()).toEqual(["space-a", "space-b"]);
    expect(runA.tenantScope?.realm).not.toBe(runB.tenantScope?.realm);
    expect(runA.tenantScope?.principal.spaceId).toBe("space-a");
    expect(runB.tenantScope?.principal.spaceId).toBe("space-b");

    await runA.dispose();
    expect(governance.scopes.has(runB.tenantScope!.realm)).toBe(true);
    const stillWorks = await runB.protocol.dispatch({ type: "control", action: "prompt", text: "again" });
    expect(stillWorks.ok).toBe(true);
    await runB.dispose();
    await governance.dispose();
  });
});
