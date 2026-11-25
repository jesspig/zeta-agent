import { describe, expect, test } from "bun:test";
import { HookChain, DEFAULT_HOOK_PRIORITY, normalizeHookError } from "./hook-chain";
import {
  AgentPluginManager,
  FAIL_CLOSED_HOOK_CHAINS,
  isFailClosedHookChain,
  LEGACY_FIELD_PRIORITY,
} from "./manager";
import { AgentPlugin, defineAgentPlugin, defineCompatExtension } from "./types";

describe("T-02 HookChain", () => {
  test("priority 升序、同值按注册序", async () => {
    const chain = new HookChain<string>();
    const seen: string[] = [];
    chain.add((input) => { seen.push("b"); return input; }, 20, "b");
    chain.add((input) => { seen.push("a"); return input; }, 10, "a");
    chain.add((input) => { seen.push("c"); return input; }, 20, "c");
    expect(chain.names).toEqual(["a", "b", "c"]);
    expect(DEFAULT_HOOK_PRIORITY).toBe(100);
    await chain.run("input");
    expect(seen).toEqual(["a", "b", "c"]);
  });

  test("串行折叠返回值，undefined 保持当前值", async () => {
    const chain = new HookChain<string>();
    chain.add((input) => `${input}-1`, 1);
    chain.add(() => undefined, 2);
    chain.add((input) => `${input}-3`, 3);
    expect(await chain.run("x")).toBe("x-1-3");
  });

  test("并行派发所有 hook 并收集结果", async () => {
    const chain = new HookChain<string>({ mode: "parallel" });
    const started: string[] = [];
    chain.add(async (input) => { started.push("a"); return `${input}a`; }, 1, "a");
    chain.add(async (input) => { started.push("b"); return `${input}b`; }, 2, "b");
    const result = await chain.run("x");
    expect(started.sort()).toEqual(["a", "b"]);
    expect(result).toBe("xb");
  });

  test("异常归一化：默认以安全回退继续，可记录失败；rethrow 模式抛出", async () => {
    const failures: string[] = [];
    const chain = new HookChain<string>({ onError: (failure) => failures.push(failure.error.message) });
    const seen: string[] = [];
    chain.add(() => { throw "boom-as-string"; }, 1, "boom");
    chain.add((input) => { seen.push("after"); return input; }, 2, "after");
    expect(await chain.run("x")).toBe("x");
    expect(seen).toEqual(["after"]);
    expect(failures).toEqual(["boom-as-string"]);
    expect(chain.lastFailures[0]?.error).toBeInstanceOf(Error);
    expect(normalizeHookError(42, "n", 0).error.message).toBe("42");

    const strict = new HookChain<string>({ rethrow: true });
    strict.add(() => { throw new Error("fatal"); }, 1);
    await expect(strict.run("x")).rejects.toThrow("fatal");
  });

  test("add 返回 disposer，disposeAll 按 LIFO 撤销", () => {
    const chain = new HookChain<string>();
    const order: string[] = [];
    chain.add(() => { order.push("a"); }, 1, "a");
    const stopB = chain.add(() => { order.push("b"); }, 2, "b");
    chain.add(() => { order.push("c"); }, 3, "c");
    stopB();
    expect(chain.names).toEqual(["a", "c"]);
    chain.disposeAll();
    expect(chain.size).toBe(0);
    expect(order).toEqual([]);
  });
});

describe("T-02 AgentPluginManager", () => {
  test("add 返回 disposer 且 priority 决定执行顺序", async () => {
    const manager = new AgentPluginManager();
    const seen: string[] = [];
    const stop = manager.addHook<string>("prepareRequest", (input) => {
      seen.push("late");
      return input;
    }, 200, "late");
    manager.addHook<string>("prepareRequest", (input) => {
      seen.push("early");
      return input;
    }, 1, "early");
    await manager.run("prepareRequest", "x");
    expect(seen).toEqual(["early", "late"]);
    stop();
    seen.length = 0;
    await manager.run("prepareRequest", "x");
    expect(seen).toEqual(["early"]);
  });

  test("LIFO 撤销所有注册", () => {
    const manager = new AgentPluginManager();
    const order: string[] = [];
    manager.addDisposer(() => order.push("a"));
    manager.addDisposer(() => order.push("b"));
    const stopC = manager.addDisposer(() => order.push("c"));
    stopC();
    stopC();
    manager.disposeAll();
    expect(order).toEqual(["c", "b", "a"]);
  });

  test("legacy 字段兼容插件以最低优先级纳入同一链", async () => {
    const manager = new AgentPluginManager();
    const order: string[] = [];
    manager.setLegacy("prepareRequest", (input) => {
      order.push("legacy");
      return input;
    });
    manager.addHook<string>("prepareRequest", (input) => {
      order.push("plugin");
      return input;
    }, 10, "plugin");
    expect(LEGACY_FIELD_PRIORITY).toBeLessThan(0);
    await manager.run("prepareRequest", "x");
    expect(order).toEqual(["legacy", "plugin"]);
    expect(manager.getLegacy("prepareRequest")).toBeDefined();
  });

  test("配置开关：关闭管线只走 legacy，开启且 hook 抛错可回退 legacy", async () => {
    const legacy = (input: unknown): unknown => `${String(input)}:legacy`;
    const enabled = new AgentPluginManager({ config: { enabled: true, fallbackToLegacy: true } });
    enabled.setLegacy("prepareRequest", legacy);
    enabled.addHook<string>("prepareRequest", () => { throw new Error("pipeline down"); }, 10, "broken");
    expect(await enabled.run("prepareRequest", "x")).toBe("x:legacy");

    const disabled = new AgentPluginManager({ config: { enabled: false, fallbackToLegacy: true } });
    disabled.setLegacy("prepareRequest", legacy);
    disabled.addHook<string>("prepareRequest", () => "should-not-run", 10, "ignored");
    expect(await disabled.run("prepareRequest", "x")).toBe("x:legacy");

    const strict = new AgentPluginManager({ config: { enabled: true, fallbackToLegacy: false } });
    strict.addHook<string>("prepareRequest", () => { throw new Error("no fallback"); }, 10, "broken");
    await expect(strict.run("prepareRequest", "x")).rejects.toThrow("no fallback");
  });

  test("install 安装插件并把逆纳入 LIFO", () => {
    const manager = new AgentPluginManager();
    let active = false;
    const plugin = {
      kind: "AgentPlugin" as const,
      name: "p",
      contributions: [],
      install() {
        active = true;
        return () => { active = false; };
      },
    };
    manager.install(plugin);
    expect(active).toBe(true);
    expect(manager.installedPlugins).toEqual([plugin]);
    manager.disposeAll();
    expect(active).toBe(false);
    expect(manager.installedPlugins).toEqual([]);
  });
});

describe("T-07 单一 plugin manager 与失败分层", () => {
  test("legacy 字段转换为 legacy:<field> 并参与同一链，普通 hook no-throw", async () => {
    const manager = new AgentPluginManager();
    const seen: string[] = [];
    manager.setLegacy("prepareRequest", (input) => {
      seen.push("legacy");
      return input;
    });
    manager.addHook<string>("prepareRequest", () => { throw "boom-as-string"; }, 10, "broken");
    manager.addHook<string>("prepareRequest", (input) => {
      seen.push("plugin");
      return input;
    }, 20, "plugin");

    const chain = manager.chain<string>("prepareRequest");
    expect(chain.snapshot().map((entry) => entry.name)).toEqual(["legacy:prepareRequest", "broken", "plugin"]);
    expect(await manager.run("prepareRequest", "x")).toBe("x");
    expect(seen).toEqual(["legacy", "plugin"]);
    expect(chain.lastFailures[0]?.error.message).toBe("boom-as-string");
  });

  test("dependsOn 拓扑排序覆盖 priority 顺序", async () => {
    const manager = new AgentPluginManager();
    manager.addHook<string>("prepareRequest", (input) => `${input}-c`, 1, "c", { dependsOn: ["a"] });
    manager.addHook<string>("prepareRequest", (input) => `${input}-a`, 200, "a");
    expect(manager.chain("prepareRequest").names).toEqual(["a", "c"]);
    expect(await manager.run("prepareRequest", "x")).toBe("x-a-c");
  });

  test("环只把目标插件标为 FAILED，其他插件继续参与同一链", async () => {
    const manager = new AgentPluginManager();
    const a = defineAgentPlugin("a", []);
    const b = defineAgentPlugin("b", []);
    const healthy = defineAgentPlugin("healthy", []);
    manager.install(a);
    manager.install(b);
    manager.install(healthy);
    manager.addHook<string>("wrap", (input) => `${input}-a`, 1, "a:first", { dependsOn: ["b:second"] });
    manager.addHook<string>("wrap", (input) => `${input}-b`, 2, "b:second", { dependsOn: ["a:first"] });
    manager.addHook<string>("wrap", (input) => `${input}-safe`, 3, "healthy:third");

    expect(manager.syncPluginStatus(a).status).toBe("FAILED");
    expect(manager.syncPluginStatus(b).status).toBe("FAILED");
    expect(manager.syncPluginStatus(healthy).status).toBe("ACTIVE");
    expect(manager.pluginStatuses.filter((record) => record.status === "FAILED")).toHaveLength(2);
    expect(manager.cycleReport).toHaveLength(1);
    expect(await manager.run("wrap", "x")).toBe("x-safe");
  });

  test("工具链 fail-closed：错误上抛且不再走 legacy 兜底", async () => {
    const manager = new AgentPluginManager();
    let legacyCalls = 0;
    manager.setLegacy("beforeToolCall", (input) => {
      legacyCalls += 1;
      return input;
    });
    manager.addHook<string>("beforeToolCall", () => { throw new Error("hook-down"); }, 10, "broken");
    expect(FAIL_CLOSED_HOOK_CHAINS).toContain("beforeToolCall");
    expect(isFailClosedHookChain("beforeToolCall")).toBe(true);
    expect(isFailClosedHookChain("prepareRequest")).toBe(false);

    await expect(manager.run("beforeToolCall", "x", undefined, { failClosed: true }))
      .rejects.toThrow("hook-down");
    // 仅链内 baseline 一次；普通 hook 的 fallback 不得在失败后再跑一遍 legacy。
    expect(legacyCalls).toBe(1);
  });

  test("普通链先 no-throw 后以 failClosed 运行时仍阻断", async () => {
    const manager = new AgentPluginManager();
    manager.addHook<string>("custom", () => { throw new Error("late-fail-closed"); }, 10, "broken");
    expect(await manager.run("custom", "x")).toBe("x");
    await expect(manager.run("custom", "x", undefined, { failClosed: true }))
      .rejects.toThrow("late-fail-closed");
  });

  test("runEach 经同一管理器逐项派发", async () => {
    const manager = new AgentPluginManager();
    manager.addHook<string>("converter", (input) => `${input}-event`, 10, "converter");
    const received: string[] = [];
    await manager.runEach("converter", "raw", undefined, (value) => {
      received.push(String(value));
    });
    expect(received).toEqual(["raw-event"]);
  });
});

describe("T-02 AgentPlugin 运行时品牌", () => {
  test("既是类型也是可导入运行时值，能识别插件", () => {
    expect(AgentPlugin.kind).toBe("AgentPlugin");
    const plugin = defineCompatExtension("compat", () => {});
    expect(AgentPlugin.is(plugin)).toBe(true);
    expect(AgentPlugin.is({})).toBe(false);
  });
});
