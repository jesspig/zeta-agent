import { describe, expect, test } from "bun:test";
import { HookChain, DEFAULT_HOOK_PRIORITY, normalizeHookError } from "./hook-chain";
import { AgentPluginManager, LEGACY_FIELD_PRIORITY } from "./manager";
import { AgentPlugin, defineCompatExtension } from "./types";

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

describe("T-02 AgentPlugin 运行时品牌", () => {
  test("既是类型也是可导入运行时值，能识别插件", () => {
    expect(AgentPlugin.kind).toBe("AgentPlugin");
    const plugin = defineCompatExtension("compat", () => {});
    expect(AgentPlugin.is(plugin)).toBe(true);
    expect(AgentPlugin.is({})).toBe(false);
  });
});
