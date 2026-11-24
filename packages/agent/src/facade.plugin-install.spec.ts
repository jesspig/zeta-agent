import { describe, expect, test } from "bun:test";
import {
  REQUIRED_ROOTS,
  defineAgentPlugin,
  type AgentPlugin,
  type PluginContribution,
} from "@zeta-agent/agent-framework";
import { createAgent } from "./facade";

const PING = { name: "ping", execute: () => "pong" };

function installSpy(contributions: readonly PluginContribution[] = [], name = "spy") {
  let installs = 0;
  let disposals = 0;
  const dispose = (): void => {
    disposals += 1;
  };
  const plugin: AgentPlugin = {
    kind: "AgentPlugin",
    name,
    contributions,
    install() {
      installs += 1;
      return dispose;
    },
  };
  return { plugin, dispose, get installs() { return installs; }, get disposals() { return disposals; } };
}

describe("T-16 插件安装事务与生命周期", () => {
  test("调用 install() 并记录 per-plugin exact disposer；disposeAll 完整可逆且幂等", () => {
    const spy = installSpy();
    const agent = createAgent({ includeBuiltins: false, plugins: [spy.plugin] });
    expect(spy.installs).toBe(1);
    expect(agent.pluginInstallations[0]?.dispose).toBe(spy.dispose);

    agent.disposeAll();
    expect(spy.disposals).toBe(1);
    agent.api.disposeAll();
    expect(spy.disposals).toBe(1);
  });

  test("install 中途失败回滚已安装项，无半注册", () => {
    const good = installSpy([{ kind: "tool", tool: PING }], "good");
    const bad: AgentPlugin = {
      kind: "AgentPlugin",
      name: "bad",
      contributions: [],
      install() {
        throw new Error("INSTALL_FAILED");
      },
    };
    expect(() => createAgent({ includeBuiltins: false, plugins: [good.plugin, bad] })).toThrow("INSTALL_FAILED");
    expect(good.installs).toBe(1);
    expect(good.disposals).toBe(1);
  });

  test("apply 中途失败同样回滚，不留半注册", () => {
    const good = installSpy([{ kind: "service", name: "locked", value: 1, replaceable: false }], "good");
    const bad = installSpy([{ kind: "service", name: "locked", value: 2 }], "bad");
    expect(() =>
      createAgent({ includeBuiltins: false, plugins: [good.plugin, bad.plugin] })
    ).toThrow("REPLACE_REJECTED");
    expect(good.installs).toBe(1);
    expect(bad.installs).toBe(1);
    expect(good.disposals).toBe(1);
    expect(bad.disposals).toBe(1);
  });
});

describe("T-16 六类 contribution 的真实执行器", () => {
  test("tool/hook/section/wrap/task/service 全部生效并可撤销", async () => {
    let hooks = 0;
    let wraps = 0;
    let tasks = 0;
    const plugin = defineAgentPlugin("all", [
      { kind: "tool", tool: PING },
      { kind: "hook", event: "agent_start", handler: () => { hooks += 1; } },
      { kind: "section", text: "PLUGIN SECTION" },
      { kind: "wrap", name: "wrap-one", handler: () => { wraps += 1; } },
      { kind: "task", name: "task-one", handler: () => { tasks += 1; } },
      { kind: "service", name: "service-one", value: 42 },
    ]);
    const agent = createAgent({
      includeBuiltins: false,
      plugins: [plugin],
      allowTextToolMarkers: true,
      streamFn: async function* () {
        yield "@@TOOL:ping:{}@@";
      },
    });

    expect(agent.toolNames).toContain("ping");
    expect(agent.pluginSections.map((item) => item.text)).toContain("PLUGIN SECTION");
    expect(agent.pluginWraps.map((item) => item.name)).toContain("wrap-one");
    expect(agent.pluginTasks.map((item) => item.name)).toContain("task-one");
    expect(agent.pluginServices.map((item) => item.name)).toContain("service-one");
    expect(agent.resolveService("service-one")).toBe(42);

    await agent.prompt("go");
    expect(hooks).toBe(1);
    expect(wraps).toBeGreaterThan(0);
    expect(tasks).toBeGreaterThan(0);

    agent.api.disposeAll();
    expect(agent.toolNames).not.toContain("ping");
    expect(agent.pluginSections).toEqual([]);
    expect(agent.pluginWraps).toEqual([]);
    expect(agent.pluginTasks).toEqual([]);
    expect(agent.pluginServices).toEqual([]);
    expect(agent.resolveService("service-one")).toBeUndefined();
  });
});

describe("T-16 同名工具替换、provider schema 与生成失效", () => {
  test("identity disposer：旧 disposer 不删同名新条目，provider schema 同步", () => {
    const agent = createAgent({ includeBuiltins: false });
    const first = agent.api.registerTool({ name: "dup", execute: () => "first" });
    const second = agent.api.registerTool({ name: "dup", execute: () => "second" });
    first();
    first();
    expect(agent.toolNames.filter((name) => name === "dup")).toEqual(["dup"]);
    expect(agent.providerToolSchemas().filter((schema) => schema.name === "dup")).toHaveLength(1);
    second();
    expect(agent.toolNames).not.toContain("dup");
    expect(agent.providerToolSchemas().filter((schema) => schema.name === "dup")).toHaveLength(0);
  });

  test("同名工具替换后执行的是新工具", async () => {
    const agent = createAgent({
      includeBuiltins: false,
      allowTextToolMarkers: true,
      streamFn: async function* () {
        yield "@@TOOL:dup:{}@@";
      },
    });
    agent.api.registerTool({ name: "dup", execute: () => "old" });
    agent.api.registerTool({ name: "dup", execute: () => "new" });
    const messages = await agent.prompt("go");
    const result = messages.find((message) => message.role === "toolResult");
    expect(String(result?.content)).toContain("new");
  });
});

describe("T-16 required root / order / realm / 不可信扩展", () => {
  test("不可替换工具同样拒绝同名覆盖", () => {
    const locked = defineAgentPlugin("locked-tool", [
      { kind: "tool", tool: { name: "locked", execute: () => 1 }, replaceable: false },
    ]);
    const override = defineAgentPlugin("override-tool", [
      { kind: "tool", tool: { name: "locked", execute: () => 2 } },
    ]);
    expect(() => createAgent({ includeBuiltins: false, plugins: [locked, override] })).toThrow("REPLACE_REJECTED");
  });

  test("required root 不可被插件同名替换", () => {
    const root = REQUIRED_ROOTS[0]!;
    const plugin = defineAgentPlugin("hijack", [
      { kind: "service", name: root, value: "evil" },
    ]);
    expect(() => createAgent({ includeBuiltins: false, plugins: [plugin] })).toThrow("REQUIRED_ROOT_REPLACED");
  });

  test("replaceable=false 的服务拒绝覆盖；order 决定 section 顺序", () => {
    const locked = defineAgentPlugin("locked", [
      { kind: "service", name: "locked-svc", value: "first", replaceable: false },
    ]);
    const override = defineAgentPlugin("override", [
      { kind: "service", name: "locked-svc", value: "second" },
      { kind: "section", text: "late", order: 200 },
      { kind: "section", text: "early", order: 1 },
    ]);
    expect(() => createAgent({ includeBuiltins: false, plugins: [locked, override] })).toThrow("REPLACE_REJECTED");

    const agent = createAgent({
      includeBuiltins: false,
      plugins: [defineAgentPlugin("sections", [
        { kind: "section", text: "late", order: 200 },
        { kind: "section", text: "early", order: 1 },
      ])],
    });
    expect(agent.pluginSections.map((item) => item.text)).toEqual(["early", "late"]);
  });

  test("realm 隔离：不同 realm 的同名服务互不覆盖", () => {
    const realmA = Symbol("a");
    const realmB = Symbol("b");
    const agent = createAgent({
      includeBuiltins: false,
      plugins: [
        defineAgentPlugin("a", [{ kind: "service", name: "shared", value: "A", realm: realmA }]),
        defineAgentPlugin("b", [{ kind: "service", name: "shared", value: "B", realm: realmB }]),
      ],
    });
    expect(agent.pluginServices).toHaveLength(2);
    expect(agent.resolveService("shared", realmA)).toBe("A");
    expect(agent.resolveService("shared", realmB)).toBe("B");
  });

  test("沙箱策略下不可信扩展只保留观察类贡献，不获得工具/服务权限", () => {
    const plugin: AgentPlugin = {
      kind: "AgentPlugin",
      name: "sandboxed",
      source: "generated",
      trusted: false,
      digest: "sha256:sandbox",
      contributions: [
        { kind: "tool", tool: { name: "sandbox-tool", execute: () => 1 } },
        { kind: "service", name: "sandbox-service", value: 1 },
        { kind: "section", text: "SANDBOX SECTION" },
      ],
      install: () => () => undefined,
    };
    const agent = createAgent({
      includeBuiltins: false,
      plugins: [plugin],
      pluginPolicy: {
        allowedCapabilities: ["tools:read"],
        digestRequired: true,
        untrusted: "sandbox",
      },
    });
    expect(agent.pluginReviews[0]?.review.decision).toBe("sandboxed");
    expect(agent.pluginInstallations).toHaveLength(1);
    expect(agent.toolNames).not.toContain("sandbox-tool");
    expect(agent.resolveService("sandbox-service")).toBeUndefined();
    expect(agent.pluginSections.map((item) => item.text)).toContain("SANDBOX SECTION");
  });

  test("不可信扩展默认禁用，并留有审查记录", () => {
    const untrusted: AgentPlugin = {
      kind: "AgentPlugin",
      name: "untrusted",
      source: "remote",
      trusted: false,
      capabilities: ["tools:read"],
      contributions: [{ kind: "tool", tool: { name: "evil", execute: () => 1 } }],
      install: () => () => undefined,
    };
    const agent = createAgent({ includeBuiltins: false, plugins: [untrusted] });
    expect(agent.toolNames).not.toContain("evil");
    expect(agent.pluginReviews[0]?.review.decision).toBe("denied");
    expect(agent.pluginInstallations).toEqual([]);
  });
});
