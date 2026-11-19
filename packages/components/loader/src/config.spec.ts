import { describe, expect, test } from "bun:test";
import {
  childId,
  deriveConfig,
  dumpConfig,
  evalJsExpr,
  isDisabled,
  isGroup,
  moduleSpecifier,
  subEntries,
  type ConfigLayer,
  type Entry,
  type PatchOp,
} from "./config";

function entry(id: string, name: string, config?: unknown): Entry {
  return { id, name, config };
}

function layer(kind: ConfigLayer["kind"], source: string, ops: PatchOp[], file = false): ConfigLayer {
  return { kind, source, file, ops };
}

function set(value: Entry): PatchOp {
  return { op: "set", entry: value };
}

describe("Entry 模型与 patch overlay", () => {
  test("模块说明符取 name 而非废弃的 url", () => {
    const raw = { id: "a", name: "./plugins/a.ts", url: "./legacy/a.js" } as Entry;
    expect(moduleSpecifier(raw)).toBe("./plugins/a.ts");
  });

  test("group.config 是子 entry 列表，id 以 ':' 分层", () => {
    const parent: Entry = {
      id: "nav",
      name: "@zeta/group",
      group: true,
      config: [entry("home", "./home.ts"), entry("admin", "./admin.ts")],
    };
    expect(isGroup(parent)).toBe(true);
    expect(subEntries(parent)).toEqual([entry("home", "./home.ts"), entry("admin", "./admin.ts")]);
    expect(childId(parent, entry("home", "./home.ts"))).toBe("nav:home");
  });

  test("disabled 同时支持 boolean 与 JsExpr，且判断返回布尔", () => {
    expect(isDisabled({ ...entry("a", "./a.ts"), disabled: true })).toBe(true);
    expect(isDisabled({ ...entry("b", "./b.ts"), disabled: { __jsExpr: "!ready" } }, { ready: false })).toBe(true);
    expect(isDisabled({ ...entry("c", "./c.ts"), disabled: { __jsExpr: "env === 'prod'" } }, { env: "dev" })).toBe(false);
    expect(isDisabled({ ...entry("d", "./d.ts"), disabled: { __jsExpr: "env === 'prod'" } }, { env: "prod" })).toBe(true);
  });

  test("JsExpr 拒绝任意代码执行与非法表达式", () => {
    expect(() => evalJsExpr({ __jsExpr: "process.exit(1)" }, {})).toThrow("INVALID_JS_EXPR");
    expect(() => evalJsExpr({ __jsExpr: "env === 'prod'" }, { env: "prod" })).not.toThrow();
  });

  test("patch 按 id 整块替换 config，而非深合并", () => {
    const result = deriveConfig([
      layer("bundle", "base", [set(entry("a", "./a.ts", { host: "local", port: 1 }))]),
      layer("patch", "p1", [set(entry("a", "./a.ts", { port: 2 }))]),
    ]);
    expect(result.entries[0]?.config).toEqual({ port: 2 });
  });

  test("分层顺序为 bundle → profile → patch → overlay，与传入顺序无关", () => {
    const result = deriveConfig([
      layer("overlay", "ov", [set(entry("a", "./a.ts", { from: "overlay" }))]),
      layer("bundle", "base", [set(entry("a", "./a.ts", { from: "bundle" }))]),
      layer("patch", "p1", [set(entry("a", "./a.ts", { from: "patch" }))]),
      layer("profile", "pr", [set(entry("a", "./a.ts", { from: "profile" }))]),
    ]);
    expect(result.entries[0]?.config).toEqual({ from: "overlay" });
    expect(result.owners.get("a")?.layer).toBe("overlay");
  });

  test("冲突时 file 来源胜出，即便其层级更早", () => {
    const result = deriveConfig([
      layer("bundle", "shipped.json", [set(entry("a", "./a.ts", { from: "file" }))], true),
      layer("overlay", "inline", [set(entry("a", "./a.ts", { from: "inline" }))], false),
    ]);
    expect(result.entries[0]?.config).toEqual({ from: "file" });
    expect(result.warnings.some((item) => item.includes("file wins"))).toBe(true);
  });

  test("name 不一致时跳过该 patch 并告警", () => {
    const result = deriveConfig([
      layer("bundle", "base", [set(entry("a", "./a.ts"))]),
      layer("patch", "p1", [set(entry("a", "./other.ts"))]),
    ]);
    expect(result.entries[0]?.name).toBe("./a.ts");
    expect(result.warnings.some((item) => item.includes("NAME_MISMATCH"))).toBe(true);
  });

  test("dumpConfig 输出稳定、可序列化且带来源归因", () => {
    const derived = deriveConfig([
      layer("bundle", "base", [set(entry("b", "./b.ts")), set(entry("a", "./a.ts"))]),
    ]);
    const dumped = dumpConfig(derived);
    expect(JSON.parse(JSON.stringify(dumped))).toEqual(dumped);
    expect(dumped.entries.map((item) => item.id)).toEqual(["a", "b"]);
    expect(dumped.entries[0]?.__owner.source).toBe("base");
  });
});
