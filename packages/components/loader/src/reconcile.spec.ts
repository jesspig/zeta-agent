import { describe, expect, test } from "bun:test";
import type { Entry } from "./config";
import {
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
