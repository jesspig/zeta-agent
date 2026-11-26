import { describe, expect, test } from "bun:test";
import { createContext, defineComponent, type BuildArtifact, type UnitInstance } from "@zeta-agent/framework";
import { defineAgentPlugin, type AgentPlugin } from "@zeta-agent/agent-framework";
import { createAgent, type HotPluginGeneration } from "../facade";
import {
  createPluginHotReloader,
  type HotReloadUnit,
} from "./hot-reload";

const units: readonly HotReloadUnit[] = [
  { id: "a", entry: "a.ts", config: { scope: "A" } },
  { id: "b", entry: "b.ts", config: { scope: "B" } },
];

function harness(overrides: {
  effect?: (unit: HotReloadUnit, value: unknown) => () => void;
  apply?: () => void;
} = {}) {
  const record: Record<string, string> = { "a.ts": "a-v1", "b.ts": "b-v1" };
  const ctx = createContext({ uid: "hmr-test" });
  const parent = ctx.use(defineComponent({ name: "parent", apply: () => () => {} }));
  const applyCalls: string[] = [];
  const reloader = createPluginHotReloader({
    ctx,
    parent,
    units,
    readFile: (path) => record[path],
    build: (unit, version, digest) => ({ id: `${unit.entry}?v=${version}`, digest, version }),
    evaluate: (artifact: BuildArtifact): UnitInstance => ({ artifact: artifact.id, value: artifact.version }),
    effect: (unit, value) => overrides.effect?.(unit, value),
    onApply: (unit) => {
      applyCalls.push(unit.id);
      overrides.apply?.();
    },
  });
  return { record, ctx, parent, reloader, applyCalls };
}

describe("T-15 插件热重载与 fiber 生命周期复用", () => {
  test("同 fiber replace/revision：uid 不变、parent/config 保留、其他 unit 会话不受影响", async () => {
    const loaded: string[] = [];
    const unloaded: string[] = [];
    const h = harness({
      effect: (unit, value) => {
        loaded.push(`${unit.id}:${String(value)}`);
        return () => unloaded.push(unit.id);
      },
    });
    const { reloader, record } = h;
    await reloader.install(units);

    const fiberA = reloader.fiberOf("a")!;
    const fiberB = reloader.fiberOf("b")!;
    expect(loaded.sort()).toEqual(["a:1", "b:1"]);

    record["a.ts"] = "a-v2";
    reloader.markDirty(["a.ts"]);
    await reloader.flush();
    expect(reloader.fiberOf("a")).toBe(fiberA);
    expect(reloader.fiberOf("b")).toBe(fiberB);
    expect(reloader.revisionOf("a")).toBe(2);
    expect(reloader.revisionOf("b")).toBe(1);
    expect(unloaded).toEqual(["a"]);
    expect(loaded.at(-1)).toBe("a:2");
    expect(reloader.valueOf("b")).toBe(1);
    await reloader.close();
  });

  test("build 失败恢复旧会话；apply 失败留 FAILED，下次变更重试", async () => {
    let failBuild = false;
    let failApply = false;
    const record: Record<string, string> = { "a.ts": "a-v1" };
    const ctx = createContext();
    const reloader = createPluginHotReloader({
      ctx,
      units: [{ id: "a", entry: "a.ts" }],
      readFile: (path) => record[path],
      build: (unit, version, digest) => {
        if (failBuild) throw new Error("BUILD_BOOM");
        return { id: `${unit.entry}?v=${version}`, digest, version };
      },
      evaluate: (artifact) => ({ artifact: artifact.id, value: artifact.version }),
      onApply: () => {
        if (failApply) throw new Error("APPLY_BOOM");
      },
    });
    await reloader.install([{ id: "a", entry: "a.ts" }]);
    const before = reloader.valueOf("a");

    record["a.ts"] = "a-v2";
    failBuild = true;
    reloader.markDirty(["a.ts"]);
    const failed = await reloader.flush();
    expect(failed.aborted).toEqual(["a"]);
    expect(reloader.valueOf("a")).toBe(before);
    expect(reloader.failed()).toEqual(["a"]);

    failBuild = false;
    failApply = true;
    const failedApply = await reloader.flush();
    expect(failedApply.settled).toEqual([]);
    expect(reloader.controller.stateOf("a")!.status).toBe("FAILED");

    failApply = false;
    record["a.ts"] = "a-v3";
    reloader.markDirty(["a.ts"]);
    const ok = await reloader.flush();
    expect(ok.settled).toEqual(["a"]);
    expect(reloader.controller.stateOf("a")!.status).toBe("ACTIVE");
    await reloader.close();
  });
});

describe("T-10 HMR 真实替换 AgentPlugin 贡献", () => {
  const unit: HotReloadUnit = { id: "plugin.ts", entry: "plugin.ts" };

  function makePlugin(
    tag: string,
    log: string[],
    disposals: { count: number },
    execute: () => unknown | Promise<unknown> = () => tag,
    onStart?: () => void
  ): AgentPlugin {
    const base = defineAgentPlugin(`plugin-${tag}`, [
      { kind: "tool", tool: { name: "ping", execute } },
      { kind: "section", text: `SECTION:${tag}` },
      { kind: "hook", event: "agent_start", handler: () => { log.push(`hook:${tag}`); } },
      { kind: "wrap", name: `wrap-${tag}`, handler: () => { log.push(`wrap:${tag}`); } },
      ...(onStart === undefined ? [] : [
        { kind: "hook" as const, event: "tool_execution_start" as const, handler: onStart },
      ]),
    ]);
    return {
      ...base,
      install() {
        const dispose = base.install();
        return () => {
          disposals.count += 1;
          dispose();
        };
      },
    };
  }

  async function waitUntil(predicate: () => boolean): Promise<void> {
    for (let index = 0; index < 1000 && !predicate(); index += 1) await Bun.sleep(1);
    expect(predicate()).toBe(true);
  }

  function harness(current: () => AgentPlugin, overrides: {
    failApply?: () => boolean;
    critical?: boolean;
    shadowed?: string[];
    compensated?: string[];
  } = {}) {
    let streams = 0;
    const agent = createAgent({
      includeBuiltins: false,
      emissionPolicy: "direct",
      streamFn: async function* () {
        const call = streams++ % 2 === 0;
        if (call) yield { type: "tool_call", id: "c1", name: "ping", arguments: "{}" };
        else yield "ok";
      },
    });
    const reloader = createPluginHotReloader<HotPluginGeneration>({
      ctx: createContext({ uid: "t10-bridge" }),
      units: [unit],
      readFile: () => current().name,
      build: (item, version, digest) => ({ id: `${item.id}:${version}`, digest, version }),
      evaluate: () => ({ artifact: "a", value: current() }),
      ...(overrides.critical === true ? { critical: [unit.id] } : {}),
      ...(overrides.shadowed === undefined ? {} : {
        shadowApply: () => { overrides.shadowed!.push("shadow"); },
      }),
      applyPlugin: (item, instance) => {
        if (overrides.failApply?.() === true) throw new Error("APPLY_BOOM");
        return agent.hotSwapPlugin(item.id, instance.value as AgentPlugin);
      },
      revertPlugin: (_item, applied) => {
        overrides.compensated?.push("revert");
        agent.revertHotPlugin(applied);
      },
    });
    return { agent, reloader };
  }

  test("文件变更真实替换工具/hook/section/wrap，旧世代 disposer 恰好一次", async () => {
    const log: string[] = [];
    const disposals = { count: 0 };
    let current = makePlugin("v1", log, disposals);
    const { agent, reloader } = harness(() => current);
    await reloader.install([unit]);

    expect(agent.toolNames).toContain("ping");
    expect(agent.pluginSections.map((item) => item.text)).toContain("SECTION:v1");
    expect(agent.pluginWraps.map((item) => item.name)).toContain("wrap-v1");
    const firstGeneration = agent.hotPluginGenerations[0]!;
    expect(firstGeneration.status).toBe("ACTIVE");
    const firstRun = await agent.prompt("go");
    expect(String(firstRun.filter((item) => item.role === "toolResult").at(-1)?.content)).toContain("v1");
    expect(log).toContain("hook:v1");
    expect(log).toContain("wrap:v1");

    current = makePlugin("v2", log, disposals);
    reloader.markDirty([unit.entry]);
    const changed = await reloader.flush();
    expect(changed.settled).toEqual([unit.id]);
    expect(agent.pluginSections.map((item) => item.text)).toContain("SECTION:v2");
    expect(agent.pluginSections.map((item) => item.text)).not.toContain("SECTION:v1");
    expect(agent.pluginWraps.map((item) => item.name)).toContain("wrap-v2");
    expect(agent.pluginWraps.map((item) => item.name)).not.toContain("wrap-v1");
    const secondRun = await agent.prompt("again");
    expect(String(secondRun.filter((item) => item.role === "toolResult").at(-1)?.content)).toContain("v2");
    expect(log).toContain("hook:v2");

    expect(firstGeneration.status).toBe("DISPOSED");
    expect(firstGeneration.disposeCount).toBe(1);
    expect(disposals.count).toBe(1);
    await reloader.close();
    await agent.dispose();
  });

  test("在途 tool 使用旧引用完成，旧世代等 lease 归零才撤销", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started = false;
    const log: string[] = [];
    const disposals = { count: 0 };
    let current = makePlugin("old", log, disposals, async () => {
      await gate;
      return "old-result";
    }, () => { started = true; });
    const { agent, reloader } = harness(() => current);
    await reloader.install([unit]);
    const oldGeneration = agent.hotPluginGenerations[0]!;

    const running = agent.prompt("go");
    await waitUntil(() => started);
    current = makePlugin("new", log, disposals, () => "new-result");
    reloader.markDirty([unit.entry]);
    expect((await reloader.flush()).settled).toEqual([unit.id]);

    expect(oldGeneration.status).toBe("RETIRING");
    expect(oldGeneration.inFlight).toBe(1);
    expect(oldGeneration.disposeCount).toBe(0);
    expect(disposals.count).toBe(0);

    release();
    const firstRun = await running;
    expect(String(firstRun.filter((item) => item.role === "toolResult").at(-1)?.content)).toContain("old-result");
    await waitUntil(() => oldGeneration.status === "DISPOSED");
    expect(oldGeneration.disposeCount).toBe(1);
    expect(disposals.count).toBe(1);

    const secondRun = await agent.prompt("again");
    expect(String(secondRun.filter((item) => item.role === "toolResult").at(-1)?.content)).toContain("new-result");
    await reloader.close();
    await agent.dispose();
  });

  test("apply 失败保留旧插件并留 FAILED，下次相关变更重试", async () => {
    const log: string[] = [];
    const disposals = { count: 0 };
    let failApply = false;
    let current = makePlugin("v1", log, disposals);
    const { agent, reloader } = harness(() => current, { failApply: () => failApply });
    await reloader.install([unit]);

    current = makePlugin("v2", log, disposals);
    failApply = true;
    reloader.markDirty([unit.entry]);
    const failed = await reloader.flush();
    expect(failed.settled).toEqual([]);
    expect(reloader.failed()).toEqual([unit.id]);
    expect(reloader.controller.stateOf(unit.id)?.status).toBe("FAILED");
    expect(agent.pluginSections.map((item) => item.text)).toContain("SECTION:v1");
    expect(agent.pluginSections.map((item) => item.text)).not.toContain("SECTION:v2");

    failApply = false;
    reloader.markDirty([unit.entry]);
    const recovered = await reloader.flush();
    expect(recovered.settled).toEqual([unit.id]);
    expect(agent.pluginSections.map((item) => item.text)).toContain("SECTION:v2");
    await reloader.close();
    await agent.dispose();
  });

  test("critical root 的 shadow-apply 与补偿可观察，失败后旧插件保持 ACTIVE", async () => {
    const log: string[] = [];
    const disposals = { count: 0 };
    const shadowed: string[] = [];
    const compensated: string[] = [];
    let failApply = false;
    let current = makePlugin("v1", log, disposals);
    const { agent, reloader } = harness(() => current, {
      critical: true,
      shadowed,
      compensated,
      failApply: () => failApply,
    });
    await reloader.install([unit]);
    const oldGeneration = agent.hotPluginGenerations[0]!;
    const shadowedBefore = shadowed.length;

    current = makePlugin("v2", log, disposals);
    failApply = true;
    reloader.markDirty([unit.entry]);
    const result = await reloader.flush();
    expect(result.settled).toEqual([]);
    expect(shadowed.length).toBe(shadowedBefore + 1);
    expect(reloader.compensationLog.map((item) => item.id)).toContain(unit.id);
    expect(oldGeneration.status).toBe("ACTIVE");
    expect(agent.pluginSections.map((item) => item.text)).toContain("SECTION:v1");
    expect(compensated).toEqual([]);
    await reloader.close();
    await agent.dispose();
  });

  function servicePlugin(
    tag: string,
    value: string,
    log: string[],
    disposals: { count: number },
    execute: () => unknown | Promise<unknown> = () => tag,
    onStart?: () => void
  ): AgentPlugin {
    const base = makePlugin(tag, log, disposals, execute, onStart);
    return {
      ...base,
      contributions: [...base.contributions, { kind: "service", name: "shared", value }],
    };
  }

  test("在途调用持有旧 service，热替换后新调用解析新 service", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started = false;
    const seen: unknown[] = [];
    const log: string[] = [];
    const disposals = { count: 0 };
    let current = servicePlugin("v1", "S1", log, disposals, async () => {
      await gate;
      return "v1";
    }, () => { started = true; });
    const { agent, reloader } = harness(() => current);
    agent.api.addPrepareRequest((request) => {
      seen.push(agent.resolveService("shared"));
      return request;
    });
    await reloader.install([unit]);
    expect(agent.resolveService("shared")).toBe("S1");
    const firstGeneration = agent.hotPluginGenerations[0]!;

    const running = agent.prompt("go");
    await waitUntil(() => started);
    expect(seen[0]).toBe("S1");

    current = servicePlugin("v2", "S2", log, disposals);
    reloader.markDirty([unit.entry]);
    expect((await reloader.flush()).settled).toEqual([unit.id]);
    // 新调用（scope 外）立即解析新 service。
    expect(agent.resolveService("shared")).toBe("S2");
    expect(firstGeneration.status).toBe("RETIRING");
    expect(firstGeneration.inFlight).toBe(1);
    expect(firstGeneration.disposeCount).toBe(0);

    release();
    await running;
    await waitUntil(() => firstGeneration.status === "DISPOSED");
    expect(firstGeneration.disposeCount).toBe(1);
    expect(disposals.count).toBe(1);

    await agent.prompt("again");
    expect(seen.at(-1)).toBe("S2");
    await reloader.close();
    await agent.dispose();
  });

  test("事务中途失败回滚保留旧 service 与旧世代，下次变更可重试", async () => {
    const log: string[] = [];
    const disposals = { count: 0 };
    let current = servicePlugin("v1", "S1", log, disposals);
    const { agent, reloader } = harness(() => current);
    await reloader.install([unit]);
    const firstGeneration = agent.hotPluginGenerations[0]!;
    expect(agent.resolveService("shared")).toBe("S1");

    // 第一个 service 成功覆盖旧值，第二个命中 required root 抛错：事务应整体回滚并恢复 S1。
    const broken: AgentPlugin = {
      kind: "AgentPlugin",
      name: "plugin-broken",
      contributions: [
        { kind: "service", name: "shared", value: "S2" },
        { kind: "service", name: "loader", value: "evil" },
      ],
      install: () => () => {},
    };
    current = broken;
    reloader.markDirty([unit.entry]);
    const failed = await reloader.flush();
    expect(failed.settled).toEqual([]);
    expect(reloader.failed()).toEqual([unit.id]);
    expect(agent.resolveService("shared")).toBe("S1");
    expect(agent.pluginSections.map((item) => item.text)).toContain("SECTION:v1");
    expect(agent.pluginSections.map((item) => item.text)).not.toContain("SECTION:v2");
    expect(firstGeneration.status).toBe("ACTIVE");
    expect(agent.hotPluginGenerations).toHaveLength(1);

    current = servicePlugin("v2", "S3", log, disposals);
    reloader.markDirty([unit.entry]);
    expect((await reloader.flush()).settled).toEqual([unit.id]);
    expect(agent.resolveService("shared")).toBe("S3");
    await reloader.close();
    await agent.dispose();
  });

  test("revert 回滚后 service 视图与插件世代一致", async () => {
    const log: string[] = [];
    const disposals = { count: 0 };
    let current = servicePlugin("v1", "S1", log, disposals);
    const { agent, reloader } = harness(() => current);
    await reloader.install([unit]);

    current = servicePlugin("v2", "S2", log, disposals);
    reloader.markDirty([unit.entry]);
    await reloader.flush();
    expect(agent.resolveService("shared")).toBe("S2");
    const secondGeneration = agent.hotPluginGenerations.at(-1)!;

    agent.revertHotPlugin(secondGeneration);
    expect(agent.resolveService("shared")).toBe("S1");
    expect(secondGeneration.status).toBe("DISPOSED");
    expect(secondGeneration.disposeCount).toBe(1);
    expect(agent.hotPluginGenerations.at(-1)?.generation).toBeGreaterThan(secondGeneration.generation);
    expect(agent.pluginSections.map((item) => item.text)).toContain("SECTION:v1");
    await reloader.close();
    await agent.dispose();
  });

  test("dispose 后 service 解析显式拒绝", async () => {
    const log: string[] = [];
    const disposals = { count: 0 };
    const current = servicePlugin("v1", "S1", log, disposals);
    const { agent, reloader } = harness(() => current);
    await reloader.install([unit]);
    expect(agent.resolveService("shared")).toBe("S1");
    await reloader.close();
    await agent.dispose();
    expect(() => agent.resolveService("shared")).toThrow(/AGENT_DISPOSED/);
  });
});
