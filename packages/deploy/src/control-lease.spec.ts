import { describe, expect, test } from "bun:test";
import { AdmissionError, grantFor, type ObjectPrincipal } from "@zeta-agent/framework";
import { acquireControlLease, createControlFence } from "./control-lease";

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
