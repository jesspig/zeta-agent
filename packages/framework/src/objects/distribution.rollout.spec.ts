import { describe, expect, test } from "bun:test";
import {
  createHost,
  createRollout,
  defineContract,
  defineFacet,
  grantFor,
  type ObjectPrincipal,
} from "./index";

const Greeter = defineContract({
  name: "example.rollout-greeter",
  version: "1",
  params: {},
  members: { greet: "method" },
});

function principal(): ObjectPrincipal {
  return { userId: "u1", spaceId: "space-a", realm: Symbol("realm-a") };
}

describe("T-19/rollout: 灰度、不串代次、回滚与排空", () => {
  test("灰度只切指定 host；route 拒绝跨代次消息", async () => {
    const rollout = createRollout({ hosts: ["h1", "h2", "h3"], initialGeneration: 1 });
    expect(rollout.generation).toBe(1);
    const report = await rollout.beginCanary(["h1"], 2);
    expect(report.canary).toEqual(["h1"]);
    expect(rollout.generation).toBe(2);
    expect(rollout.generationFor("h1")).toBe(2);
    expect(rollout.generationFor("h2")).toBe(1);
    expect(rollout.route("h1", 2)).toBe(true);
    expect(rollout.route("h1", 1)).toBe(false); // 旧进程迟到消息
    expect(rollout.route("h2", 2)).toBe(false); // 未灰度 host 不接受新代次
    await rollout.close();
  });

  test("promote 全量；rollback 恢复上一代次并排空旧工作", async () => {
    const rollout = createRollout({ hosts: ["h1", "h2"], initialGeneration: 1 });
    await rollout.beginCanary(["h1"], 2);
    const promoted = await rollout.promote();
    expect(promoted.promoted).toEqual(["h2"]);
    expect(rollout.generationFor("h2")).toBe(2);

    const lease = rollout.acquireWork("h2");
    const rolled = await rollout.rollback();
    expect(rolled.rolledBack.sort()).toEqual(["h1", "h2"]);
    expect(rollout.generation).toBe(1);
    expect(rollout.generationFor("h1")).toBe(1);
    expect(rollout.hosts().every((host) => host.draining)).toBe(true);

    let drained = false;
    const draining = rollout.drain().then((ids) => {
      drained = true;
      return ids;
    });
    await Promise.resolve();
    expect(drained).toBe(false); // 在途工作未释放，排空未完成
    lease.release();
    expect((await draining).sort()).toEqual(["h1", "h2"]);
    expect(rollout.hosts().every((host) => !host.draining)).toBe(true);
    await rollout.close();
  });

  test("hold/call 恢复：旧引用继续旧代次，新引用取新代次且不被串代", async () => {
    let version = "v1";
    const facet = () => {
      const v = version;
      return defineFacet((host) => {
        host.serve(
          Greeter,
          () => ({ greet: (name: string) => `${v}:${name}` }),
          { digest: v }
        );
      });
    };
    const host = createHost();
    await host.load([{ name: "g", facet: facet() }]);
    const p = principal();
    const ctx = { principal: p, grant: grantFor(p, [Greeter.name]) };
    const held = await host.hold<{ greet(n: string): string }>(Greeter, {}, ctx);
    await held.ready;
    const oldGeneration = held.generation;

    version = "v2";
    const report = await host.reload([{ name: "g", facet: facet() }]);
    expect(report.restarted).toHaveLength(1);
    const next = await host.get<{ greet(n: string): string }>(Greeter, {}, ctx);
    await next.ready;
    expect(held.generation).toBe(oldGeneration);
    expect(held.value?.greet("x")).toBe("v1:x");
    expect(next.generation).toBeGreaterThan(oldGeneration);
    expect(next.value?.greet("x")).toBe("v2:x");

    const rollout = createRollout({ hosts: ["worker"], initialGeneration: oldGeneration });
    await rollout.beginCanary(["worker"], next.generation);
    expect(rollout.route("worker", held.generation)).toBe(false);
    expect(rollout.route("worker", next.generation)).toBe(true);
    held.release();
    next.release();
    await host.close();
    await rollout.close();
  });
});
