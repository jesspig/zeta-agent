import { describe, expect, test } from "bun:test";
import type { CoeffectKey } from "@zeta-agent/cordis/types";
import { flattenEntries, type Entry } from "./config";
import {
  applyReconcile,
  createReconcileState,
  realmFor,
  reconcile,
  Reconciler,
  type ReconcileAction,
  type ReconcileState,
} from "./reconcile";

function entry(id: string, name: string, extra: Partial<Entry> = {}): Entry {
  return { id, name, ...extra };
}

function attachHost(reconciler: Reconciler): ReconcileAction[] {
  const seen: ReconcileAction[] = [];
  reconciler.onAction((action) => seen.push(action));
  return seen;
}

describe("entry 对账与 realm 重分配", () => {
  test("新 entry 加入产生 insert，消失 entry 触发 unload 且从状态移除", () => {
    const a = entry("a", "./a.ts");
    const b = entry("b", "./b.ts");
    const reconciler = new Reconciler();
    const seen = attachHost(reconciler);
    const first = reconciler.reconcile([a, b]);
    expect(first.actions.map((item) => item.kind)).toEqual(["insert", "insert"]);
    const second = reconciler.reconcile([a]);
    expect(second.actions.map((item) => item.kind)).toEqual(["unload"]);
    expect(second.actions[0]?.entry.id).toBe("b");
    expect(second.state.entries.has("b")).toBe(false);
    expect(seen.filter((item) => item.kind === "unload").map((item) => item.entry.id)).toEqual(["b"]);
  });

  test("相同 entry 列表重复对账为空操作", () => {
    const reconciler = new Reconciler();
    const a = entry("a", "./a.ts");
    reconciler.reconcile([a]);
    expect(reconciler.reconcile([a]).actions).toEqual([]);
  });

  test("string label 跨 entry 共享 realm，true 为局部 realm 且跨对账稳定", () => {
    const a = entry("a", "./a.ts", { isolate: { db: "shared" } });
    const b = entry("b", "./b.ts", { isolate: { db: "shared" } });
    const c = entry("c", "./c.ts", { isolate: { db: true } });
    const reconciler = new Reconciler();
    const result = reconciler.reconcile([a, b, c]);
    const ra = realmFor(result.state, "a", "db");
    const rb = realmFor(result.state, "b", "db");
    const rc = realmFor(result.state, "c", "db");
    expect(typeof ra).toBe("symbol");
    expect(ra).toBe(rb);
    expect(rc).not.toBe(ra);
    const next = reconciler.reconcile([a, b, c]);
    expect(realmFor(next.state, "c", "db")).toBe(rc);
    const other = new Reconciler().reconcile([a]);
    expect(realmFor(other.state, "a", "db")).toBe(ra);
  });

  test("isolate 变化触发 realm 重分配而不卸载 entry", () => {
    const reconciler = new Reconciler();
    reconciler.reconcile([entry("a", "./a.ts", { isolate: { db: "one" } })]);
    const next = reconciler.reconcile([entry("a", "./a.ts", { isolate: { db: "two" } })]);
    expect(next.actions.map((item) => item.kind)).toEqual(["realm"]);
    expect(realmFor(next.state, "a", "db")).toBe(Symbol.for("two"));
  });

  test("intercept 与 config 逐字段对账，volatile 走 notify 而非 reload", () => {
    const reconciler = new Reconciler();
    const base = entry("a", "./a.ts", { config: { v: 1 }, intercept: { log: true } });
    reconciler.reconcile([base]);
    const changed = entry("a", "./a.ts", { config: { v: 2 }, intercept: { log: false } });
    const result = reconciler.reconcile([changed]);
    expect(result.actions.map((item) => item.kind).sort()).toEqual(["intercept", "reload"]);

    const volatileReconciler = new Reconciler();
    const v1 = entry("v", "./v.ts", { config: { v: 1 }, volatile: true });
    volatileReconciler.reconcile([v1]);
    const v2 = entry("v", "./v.ts", { config: { v: 2 }, volatile: true });
    expect(volatileReconciler.reconcile([v2]).actions.map((item) => item.kind)).toEqual(["notify"]);
  });

  test("disabled 切换为 unload / insert", () => {
    const reconciler = new Reconciler();
    const active = entry("a", "./a.ts");
    reconciler.reconcile([active]);
    expect(reconciler.reconcile([entry("a", "./a.ts", { disabled: true })]).actions.map((item) => item.kind)).toEqual([
      "unload",
    ]);
    expect(reconciler.reconcile([active]).actions.map((item) => item.kind)).toEqual(["insert"]);
  });

  test("name 变化触发重建，携带旧 entry 供卸载", () => {
    const reconciler = new Reconciler();
    reconciler.reconcile([entry("a", "./a.ts")]);
    const result = reconciler.reconcile([entry("a", "./a-v2.ts")]);
    expect(result.actions.map((item) => item.kind)).toEqual(["unload", "insert"]);
    expect(result.actions[0]?.previous?.name).toBe("./a.ts");
  });

  test("纯函数 reconcile 不修改传入状态，重复 id 抛错", () => {
    const empty = createReconcileState();
    const result = reconcile(empty, [entry("a", "./a.ts")]);
    expect(empty.entries.size).toBe(0);
    expect(result.state.entries.size).toBe(1);
    expect(() => reconcile(empty, [entry("a", "./a.ts"), entry("a", "./b.ts")])).toThrow("DUPLICATE_ENTRY_ID");
  });
});

describe("T-05 reconcile 真正执行器", () => {
  test("name 变化严格等待旧 fiber 去活后才 insert", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const host = async (action: ReconcileAction): Promise<void> => {
      if (action.kind === "unload") {
        order.push("unload:start");
        await gate;
        order.push("unload:end");
      } else {
        order.push(action.kind);
        return;
      }
    };
    const reconciler = new Reconciler();
    await reconciler.apply([entry("a", "./a.ts")], host);

    const pending = reconciler.apply([entry("a", "./a-v2.ts")], host);
    expect(order).toEqual(["insert", "unload:start"]);
    release();
    await pending;
    expect(order).toEqual(["insert", "unload:start", "unload:end", "insert"]);
  });

  test("group 递归 keyed diff：增删子项只影响对应 key，并带父/组归属", async () => {
    const group = (children: readonly Entry[]): Entry => ({
      id: "nav",
      name: "@zeta/group",
      group: true,
      config: children,
    });
    const seen: string[] = [];
    const host = (action: ReconcileAction): void => {
      seen.push(`${action.kind}:${action.entry.id}:${action.parent ?? "-"}:${action.group ?? "-"}`);
    };
    const reconciler = new Reconciler();
    const children = [entry("home", "./home.ts"), entry("admin", "./admin.ts")];
    await reconciler.apply([group(children)], host);
    expect(seen).toEqual(["insert:nav:home:nav:nav", "insert:nav:admin:nav:nav"]);

    await reconciler.apply([group([...children, entry("extra", "./extra.ts")])], host);
    expect(seen.at(-1)).toBe("insert:nav:extra:nav:nav");

    await reconciler.apply([group([entry("home", "./home.ts")])], host);
    expect(seen.slice(-2)).toEqual(["unload:nav:admin:nav:nav", "unload:nav:extra:nav:nav"]);
    // home 的 key 未被触碰，不产生任何 reload/unload。
    expect(seen.filter((item) => item.startsWith("unload") || item.startsWith("reload"))).toHaveLength(2);
    expect(flattenEntries([group(children)]).map((item) => item.entry.id)).toEqual(["nav:home", "nav:admin"]);
  });

  test("isolate 删除携带迁移信息，不刷新无关 realm 的 entry", async () => {
    const hostActions: ReconcileAction[] = [];
    const reconciler = new Reconciler();
    await reconciler.apply(
      [
        entry("a", "./a.ts", { isolate: { db: "shared" } }),
        entry("b", "./b.ts", { isolate: { db: "shared" } }),
      ],
      (action) => {
        hostActions.push(action);
      }
    );
    const before = realmFor(reconciler.state, "b", "db");
    hostActions.length = 0;
    await reconciler.apply(
      [
        entry("a", "./a.ts", { isolate: {} }),
        entry("b", "./b.ts", { isolate: { db: "shared" } }),
      ],
      (action) => {
        hostActions.push(action);
      }
    );
    expect(hostActions.map((item) => item.kind)).toEqual(["realm"]);
    expect(hostActions[0]?.removedRealms).toEqual(["db"]);
    expect(hostActions[0]?.entry.id).toBe("a");
    // 未变更的 b 维持原 realm，也无 reload/notify 动作。
    expect(realmFor(reconciler.state, "b", "db")).toBe(before);
  });

  test("inject 经 resolveKey 解析为 action.keys 并真实参与动作", async () => {
    const key = (name: string): CoeffectKey<unknown> => ({
      namespace: "@zeta-agent/entry",
      name,
      symbol: Symbol(name),
    });
    const seen: Array<readonly CoeffectKey<any>[] | undefined> = [];
    await applyReconcile(
      createReconcileState(),
      [entry("a", "./a.ts", { inject: ["db", "cache"] })],
      (action) => {
        seen.push(action.keys);
      },
      { resolveKey: key }
    );
    expect(seen[0]?.map((item) => item?.name)).toEqual(["db", "cache"]);

    const renamed = await applyReconcile(
      createReconcileState(),
      [entry("a", "./a.ts", { inject: { alias: "db" } })],
      () => undefined,
      { resolveKey: key }
    );
    expect(renamed.actions[0]?.keys?.map((item) => item.name)).toEqual(["db"]);
  });

  test("update(config) 经 reload 动作生效，self-disable 回写而不是静默丢弃", async () => {
    const seen: unknown[] = [];
    const host = (action: ReconcileAction): void => {
      if (action.kind === "insert" || action.kind === "reload") seen.push(action.entry.config);
    };
    const reconciler = new Reconciler();
    await reconciler.apply([entry("a", "./a.ts", { config: { v: 1 } })], host);
    const updated = await reconciler.apply([entry("a", "./a.ts", { config: { v: 2 } })], host);
    expect(seen).toEqual([{ v: 1 }, { v: 2 }]);
    expect(updated.actions.map((item) => item.kind)).toEqual(["reload"]);

    const disabled = await reconciler.apply([entry("a", "./a.ts", { disabled: true })], host);
    expect(disabled.disabled).toEqual(["a"]);
    expect(disabled.state.entries.has("a")).toBe(true);
    expect(disabled.state.active.has("a")).toBe(false);
    expect(disabled.actions.map((item) => item.kind)).toEqual(["unload"]);
  });

  test("执行器抛错时不提交状态，便于上层重试", async () => {
    const reconciler = new Reconciler();
    await reconciler.apply([entry("a", "./a.ts")], () => undefined);
    let error: unknown;
    try {
      await reconciler.apply([entry("a", "./a-v2.ts")], () => {
        throw new Error("HOST_BOOM");
      });
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain("HOST_BOOM");
    expect(reconciler.state.entries.get("a")?.name).toBe("./a.ts");
  });
});
