import { describe, expect, test } from "bun:test";
import { createContext, defineComponent, type BuildArtifact, type UnitInstance } from "@zeta-agent/framework";
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
