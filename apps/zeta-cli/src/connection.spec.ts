import { describe, expect, test } from "bun:test";
import { createConnectionSequence, selectModelAfterConnect } from "./index";
import { createConnectionOutbound, createDefaultDenyOutbound } from "./connection";

/** CR-05：连接后必须得到属于新端点列表的有效模型，不能是空串。 */
describe("T-05 连接后的模型选择", () => {
  test("未连接状态（echo）首次连接采用首个模型", () => {
    expect(selectModelAfterConnect("echo", ["m1", "m2"])).toBe("m1");
  });

  test("旧模型不在新列表时改用首个模型", () => {
    expect(selectModelAfterConnect("old-model", ["m1", "m2"])).toBe("m1");
  });

  test("旧模型仍在新列表时保留用户选择", () => {
    expect(selectModelAfterConnect("m2", ["m1", "m2"])).toBe("m2");
  });

  test("空模型列表时不应产生空串模型（返回 undefined 交由上层阻断发送）", () => {
    expect(selectModelAfterConnect("echo", [])).toBeUndefined();
  });
});

/** CR-06：迟到的连接结果不得覆盖更新的连接。 */
describe("T-06 连接代次控制", () => {
  test("较早的代次在更新发起后变为过期", () => {
    const seq = createConnectionSequence();
    const g1 = seq.next();
    expect(seq.isCurrent(g1)).toBe(true);
    const g2 = seq.next();
    expect(seq.isCurrent(g1)).toBe(false);
    expect(seq.isCurrent(g2)).toBe(true);
  });
});

/** T-11：CLI connect 的显式 allow 来自用户配置端点，默认拒绝不得联网。 */
describe("T-11 CLI 连接出站边界", () => {
  test("无 allow 规则时 fetch 抛配置错误，不触达底层 fetch", async () => {
    let calls = 0;
    const baseFetch = (async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const denied = createDefaultDenyOutbound(baseFetch);
    await expect(denied.fetch("https://api.test/v1/models")).rejects.toThrow("EGRESS_ALLOW_REQUIRED");
    expect(calls).toBe(0);
  });

  test("显式端点推导 allow，重定向到未放行 origin 时逐跳拒绝", async () => {
    const calls: string[] = [];
    let first = true;
    const baseFetch = (async (input: Parameters<typeof fetch>[0]) => {
      calls.push(String(input));
      if (first) {
        first = false;
        return new Response(null, { status: 302, headers: { location: "https://evil.test/v1/models" } });
      }
      return new Response(JSON.stringify({ data: [{ id: "m1" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const outbound = createConnectionOutbound("https://api.test/v1", baseFetch);
    await expect(outbound.fetch("https://api.test/v1/models")).rejects.toThrow("EGRESS_DENIED");
    expect(calls).toEqual(["https://api.test/v1/models"]);

    const okFetch = (async () => new Response(JSON.stringify({ data: [{ id: "m1" }] }), { status: 200 })) as unknown as typeof fetch;
    expect((await createConnectionOutbound("https://api.test/v1", okFetch).fetch("https://api.test/v1/models")).ok).toBe(true);
  });
});
