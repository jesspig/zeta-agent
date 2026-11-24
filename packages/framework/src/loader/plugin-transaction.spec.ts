import { describe, expect, test } from "bun:test";
import {
  createPluginTransaction,
  identityDisposer,
  type StagedInstallable,
} from "./plugin-transaction";

interface TestPlugin extends StagedInstallable {
  readonly dispose: () => void;
  readonly installs: number;
}

function plugin(name: string, onDispose?: () => void): TestPlugin {
  const dispose = (): void => onDispose?.();
  let installs = 0;
  return {
    name,
    dispose,
    get installs() {
      return installs;
    },
    install() {
      installs += 1;
      return dispose;
    },
  };
}

describe("T-16 插件 staging → validate → commit", () => {
  test("commit 调用 install() 并记录 per-plugin 原样 disposer", () => {
    let generation = 4;
    const tx = createPluginTransaction<TestPlugin>({ generation: () => generation });
    const a = plugin("a");
    const b = plugin("b");
    tx.stage([{ item: a }, { item: b }]);

    expect(tx.validate()).toEqual([]);
    const result = tx.commit({ apply: () => undefined });
    expect(result.error).toBeUndefined();
    expect(a.installs).toBe(1);
    expect(b.installs).toBe(1);
    expect(result.installed.map((record) => record.dispose)).toEqual([a.dispose, b.dispose]);
    expect(tx.staged).toEqual([]);
  });

  test("commit 中途失败时回滚全部已安装项，不留半注册", () => {
    const disposed: string[] = [];
    const a = plugin("a", () => disposed.push("a"));
    const b = plugin("b", () => disposed.push("b"));
    const tx = createPluginTransaction<TestPlugin>();
    tx.stage([{ item: a }, { item: b }]);

    const result = tx.commit({
      apply: (entry) => {
        if (entry.item.name === "b") throw new Error("APPLY_FAILED");
      },
    });
    expect(result.error).toBeInstanceOf(Error);
    expect(result.installed).toEqual([]);
    expect(result.rolledBack.map((record) => record.entry.item.name)).toEqual(["b", "a"]);
    expect(disposed).toEqual(["b", "a"]);
    expect(b.installs).toBe(1);
    expect(tx.staged).toEqual([]);
  });

  test("validate 收集问题且不触发任何 install", () => {
    const a = plugin("a");
    const tx = createPluginTransaction<TestPlugin>();
    tx.stage([{ item: a, meta: { name: "" } }, { item: a }]);
    // 自定义规则：meta.name 为空视为非法。
    const issues = tx.validate([
      (entry) => (entry.meta.name === "" ? "NAME_REQUIRED" : undefined),
    ]);
    expect(issues.map((issue) => issue.reason)).toEqual(["NAME_REQUIRED"]);
    expect(a.installs).toBe(0);
    expect(tx.staged).toHaveLength(2);
  });

  test("generation 过期的暂存项在 commit 时被跳过（stale 失效）", () => {
    let generation = 1;
    const tx = createPluginTransaction<TestPlugin>({ generation: () => generation });
    const a = plugin("a");
    tx.stage([{ item: a }]);
    generation += 1; // 另一路 reload 推进了 generation

    const result = tx.commit({ apply: () => undefined });
    expect(result.installed).toEqual([]);
    expect(result.stale.map((entry) => entry.item.name)).toEqual(["a"]);
    expect(a.installs).toBe(0);
  });

  test("discard 清空暂存且不安装", () => {
    const tx = createPluginTransaction<TestPlugin>();
    const a = plugin("a");
    tx.stage([{ item: a }]);
    tx.discard();
    expect(tx.staged).toEqual([]);
    expect(a.installs).toBe(0);
  });

  test("元数据 order/realm/required 原样记录在暂存项", () => {
    const realm = Symbol("r");
    const tx = createPluginTransaction<TestPlugin>();
    const [entry] = tx.stage([
      { item: plugin("a"), meta: { order: 7, realm, required: true, replaceable: false } },
    ]);
    expect(entry?.order).toBe(7);
    expect(entry?.realm).toBe(realm);
    expect(entry?.required).toBe(true);
    expect(entry?.replaceable).toBe(false);
  });
});

describe("T-16 identity disposer：旧 disposer 不删新条目", () => {
  test("按 value 身份删除，旧 disposer 对同名新条目无效", () => {
    const map = new Map<string, { id: number }>();
    const first = { id: 1 };
    const second = { id: 2 };
    map.set("tool", first);
    const disposeOld = identityDisposer(map, "tool", first);
    map.set("tool", second);
    disposeOld();
    expect(map.get("tool")).toBe(second);
    disposeOld(); // 幂等
    expect(map.get("tool")).toBe(second);
  });

  test("新 disposer 仍能删除自己的条目", () => {
    const map = new Map<string, { id: number }>();
    const value = { id: 1 };
    map.set("tool", value);
    identityDisposer(map, "tool", value)();
    expect(map.has("tool")).toBe(false);
  });
});
