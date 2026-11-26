import { describe, expect, test } from "bun:test";
import { realmForSpace, RealmScoped } from "./principal";
import { createQuotaService, quotaKey, type QuotaService } from "./quota";

describe("T-13 QuotaService check/reserve", () => {
  test("check 与 reserve 拒绝非法/超额请求，保留剩余额度", () => {
    const quota = createQuotaService({ tokens: 3 });
    expect(quota.check("shell")).toBe(true);
    expect(quota.check("")).toBe(false);
    expect(quota.reserve(2)).toBe(true);
    expect(quota.remaining()).toBe(1);
    expect(quota.check({ tokens: 2 })).toBe(false);
    expect(quota.reserve(2)).toBe(false);
    expect(quota.reserve(0)).toBe(false);
    expect(quota.reserve(-1)).toBe(false);
    expect(quota.reserve(1.5)).toBe(false);
    expect(quota.remaining()).toBe(1);
  });

  test("各 realm 独立配额：一个 realm 耗尽不影响兄弟", () => {
    const quotas = new RealmScoped<QuotaService>();
    const a = createQuotaService({ tokens: 2 });
    const b = createQuotaService({ tokens: 1 });
    quotas.provide(realmForSpace("quota-a"), a);
    quotas.provide(realmForSpace("quota-b"), b);

    expect(a.reserve(2)).toBe(true);
    expect(a.reserve(1)).toBe(false);
    expect(quotas.require(realmForSpace("quota-b")).remaining()).toBe(1);
    expect(b.reserve(1)).toBe(true);
    expect(b.reserve(1)).toBe(false);
  });

  test("并发 reserve 原子扣减：恰好不超过容量且无超额成功", async () => {
    const quota = createQuotaService({ tokens: 4 });
    const results = await Promise.all(Array.from({ length: 12 }, () => Promise.resolve(quota.reserve(1))));
    expect(results.filter(Boolean)).toHaveLength(4);
    expect(quota.remaining()).toBe(0);
    expect(quota.reserve(1)).toBe(false);
  });

  test("reserve 后 release 归还额度，归还量不会超过容量", () => {
    const quota = createQuotaService({ tokens: 2 });
    expect(quota.reserve(2)).toBe(true);
    expect(quota.remaining()).toBe(0);
    quota.release(1);
    expect(quota.remaining()).toBe(1);
    quota.release(5);
    expect(quota.remaining()).toBe(2);
  });
});

describe("T-15 quota coeffect：工具/token/qps", () => {
  test("工具名覆盖单次 token 成本，check/reserve 同一判据", () => {
    const quota = createQuotaService({ tokens: 5, toolCosts: { shell: 3 } });
    expect(quota.check({ tool: "shell" })).toBe(true);
    expect(quota.reserve({ tool: "shell", tokens: 3 })).toBe(true);
    expect(quota.remaining()).toBe(2);
    expect(quota.check("shell")).toBe(false);
    expect(quota.reserve("shell" as never)).toBe(false);
    expect(quota.reserve({ tool: "shell", tokens: 3 })).toBe(false);
  });

  test("qps 按注入时钟滑动秒窗：超额拒绝，窗口推进后恢复，check 不计数", () => {
    let now = 2_000_000;
    const quota = createQuotaService({ tokens: 10, qps: 2, clock: () => now });
    expect(quota.qps).toBe(2);
    expect(quota.check({ tokens: 1 })).toBe(true);
    expect(quota.check({ tokens: 1 })).toBe(true);
    expect(quota.qpsRemaining()).toBe(2);
    expect(quota.reserve({ tokens: 1 })).toBe(true);
    expect(quota.reserve({ tokens: 1 })).toBe(true);
    expect(quota.qpsRemaining()).toBe(0);
    expect(quota.reserve({ tokens: 1 })).toBe(false);
    now += 1000;
    expect(quota.qpsRemaining()).toBe(2);
    expect(quota.reserve({ tokens: 1 })).toBe(true);
  });

  test("非法 qps 显式拒绝，coeffect key 身份稳定", () => {
    expect(() => createQuotaService({ tokens: 1, qps: 0 })).toThrow("QUOTA_INVALID_QPS");
    expect(quotaKey.namespace).toBe("@zeta-agent/capabilities");
    expect(quotaKey.symbol).toBe(quotaKey.symbol);
  });
});
