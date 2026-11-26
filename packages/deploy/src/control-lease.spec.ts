import { describe, expect, test } from "bun:test";
import { AdmissionError, grantFor, type ObjectPrincipal } from "@zeta-agent/framework";
import { acquireControlLease, createControlFence, createLeaseRenewer } from "./control-lease";

const principal: ObjectPrincipal = { userId: "u1", spaceId: "s1", realm: Symbol("control-realm") };

describe("T-21 control lease 与替换代次栅栏", () => {
  test("只有当前 holder 可续约，过期后可被接管且代次递增", () => {
    let now = 1000;
    const fence = createControlFence({ now: () => now, ttlMs: 100 });
    const first = fence.tryAcquire("daemon-a");
    expect(first).toBeDefined();
    expect(first!.owner).toBe("daemon-a");
    expect(fence.tryAcquire("daemon-b")).toBeUndefined();

    now = 1100;
    expect(first!.renew()).toBe(false);
    const second = fence.tryAcquire("daemon-b");
    expect(second).toBeDefined();
    expect(second!.generation).toBeGreaterThan(first!.generation);
    expect(fence.isCurrent(first!.generation)).toBe(false);
    expect(fence.isCurrent(second!.generation)).toBe(true);
  });

  test("replace 提升代次并隔离旧 holder 的迟到消息", () => {
    const fence = createControlFence({ initialGeneration: 4 });
    const old = fence.replace("old-owner");
    const next = fence.replace("new-owner");
    expect(next.generation).toBe(old.generation + 1);
    expect(fence.isCurrent(old.generation)).toBe(false);
    expect(old.isCurrent(old.generation)).toBe(false);
    expect(next.isCurrent(next.generation)).toBe(true);
    expect(fence.holder).toBe("new-owner");
  });

  test("release 后重新获取仍提升代次，避免 ABA 复用", () => {
    const fence = createControlFence();
    const first = fence.tryAcquire("a")!;
    const firstGeneration = first.generation;
    first.release();
    const second = fence.tryAcquire("b")!;
    expect(second.generation).toBeGreaterThan(firstGeneration);
  });

  test("准入失败 fail-closed：没有 principal/grant 直接被拒", () => {
    const fence = createControlFence({ admission: { context: {} } });
    expect(() => fence.tryAcquire("bad")).toThrow(AdmissionError);
    expect(fence.holder).toBeUndefined();
  });

  test("准入放行复用 T-19 grant，不另建身份路径", () => {
    const grant = grantFor(principal, ["control"], { actions: ["rpc"] });
    const fence = createControlFence({
      admission: {
        context: { principal, grant, resource: "control", action: "rpc" },
      },
    });
    const lease = acquireControlLease({
      owner: "admitted",
      admission: {
        context: { principal, grant, resource: "control", action: "rpc" },
      },
    });
    expect(fence.tryAcquire("admitted")?.active).toBe(true);
    expect(lease.active).toBe(true);
    expect(lease.decision.kind).toBe("allow");
  });
});

describe("T-16 租约续期状态机", () => {
  test("假时钟跨多个 TTL 周期持续续租，租约始终 active", () => {
    let now = 1000;
    const fence = createControlFence({ now: () => now, ttlMs: 100 });
    const lease = fence.tryAcquire("daemon")!;
    const phases: string[] = [];
    const renewer = createLeaseRenewer({
      lease,
      ttlMs: 100,
      now: () => now,
      onPhaseChange: (phase) => phases.push(phase),
    });
    for (let cycle = 1; cycle <= 6; cycle += 1) {
      now = 1000 + cycle * 30;
      expect(renewer.tick()).toBe(true);
      expect(renewer.active).toBe(true);
      expect(renewer.lease.expiresAt).toBe(now + 100);
      expect(fence.holder).toBe("daemon");
    }
    expect(renewer.renewals).toBe(6);
    expect(renewer.failures).toBe(0);
    expect(phases).toEqual([]);
    renewer.release();
  });

  test("续租失败立即 EXPIRED，active=false，随后可重新获取恢复", () => {
    let now = 1000;
    const fence = createControlFence({ now: () => now, ttlMs: 100 });
    const lease = fence.tryAcquire("daemon")!;
    const phases: string[] = [];
    const renewer = createLeaseRenewer({
      lease,
      ttlMs: 100,
      now: () => now,
      reacquire: () => fence.tryAcquire("daemon") ?? undefined,
      onPhaseChange: (phase, reason) => phases.push(`${phase}:${reason}`),
    });

    // 跳过整个 TTL 才 tick：续租必然失败，租约立刻失效。
    now = 1200;
    expect(renewer.tick()).toBe(false);
    expect(renewer.phase).toBe("expired");
    expect(renewer.active).toBe(false);
    expect(renewer.failures).toBe(1);

    // 下一个周期重新获取：代次提升，迟到消息被栅栏隔离。
    const staleGeneration = renewer.lease.generation;
    expect(renewer.tick()).toBe(true);
    expect(renewer.phase).toBe("active");
    expect(renewer.active).toBe(true);
    expect(renewer.lease.generation).toBeGreaterThan(staleGeneration);
    expect(fence.isCurrent(staleGeneration)).toBe(false);
    expect(phases).toEqual(["expired:RENEW_FAILED", "active:RECOVERED"]);
    renewer.release();
  });

  test("无重新获取路径时保持过期，不会自行恢复", () => {
    let now = 1000;
    const lease = acquireControlLease({ owner: "solo", now: () => now, ttlMs: 100 });
    const renewer = createLeaseRenewer({ lease, ttlMs: 100, now: () => now });
    now = 1100;
    expect(renewer.tick()).toBe(false);
    expect(renewer.tick()).toBe(false);
    expect(renewer.active).toBe(false);
    expect(renewer.phase).toBe("expired");
  });
});
