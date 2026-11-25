import { describe, expect, test } from "bun:test";
import { defineComponent, defineKey } from "../context";
import {
  discoverComponents,
  discoverHmrUnits,
  type ComponentDeclaration,
  type HmrDiscoverySource,
} from "./discovery";

const component = (name: string) =>
  defineComponent({ name, inject: [], provide: [], apply: () => () => {} });

const entry = (name: string) => ({ id: name, name });

describe("T-05 发现层：facet/package/收窄子类", () => {
  test("facet/package 声明与裸 Component 子类都能解析 entry", () => {
    const discovery = discoverComponents([
      { kind: "facet", name: "./facet.ts", component: component("./facet.ts") },
      { kind: "package", name: "pkg", components: [component("./pkg-a.ts")] },
      component("./bare.ts"),
    ]);
    expect(discovery.facets).toEqual(["./facet.ts"]);
    expect(discovery.packages).toEqual(["pkg"]);
    expect(discovery.resolve(entry("./facet.ts")).name).toBe("./facet.ts");
    expect(discovery.resolve(entry("./pkg-a.ts")).name).toBe("./pkg-a.ts");
    expect(discovery.resolve(entry("./bare.ts")).name).toBe("./bare.ts");
  });

  test("文档化收窄子类不命中时仍由 resolve 显式拒绝，不静默降级", () => {
    const key = defineKey("@zeta-agent/discovery-test", "narrow");
    const discovery = discoverComponents([
      {
        kind: "facet",
        name: "./narrow.ts",
        component: { ...component("./narrow.ts"), inject: [key] },
        accepts: (item) => item.inject !== undefined,
      },
    ]);
    expect(discovery.resolve({ ...entry("./narrow.ts"), inject: ["x"] }).name).toBe("./narrow.ts");
    expect(() => discovery.resolve(entry("./narrow.ts"))).toThrow("UNSUPPORTED_ENTRY");
  });

  test("无法识别的声明显式抛错", () => {
    const bad = { kind: "plugin", name: "./x.ts" } as unknown as ComponentDeclaration;
    expect(() => discoverComponents([bad])).toThrow("UNSUPPORTED_DISCOVERY_ENTRY");
    expect(() => discoverComponents([null as unknown as ComponentDeclaration])).toThrow(
      "UNSUPPORTED_DISCOVERY_ENTRY"
    );
  });

  test("HMR 侧 facet/package 产出 unit，重复与不支持项显式拒绝", () => {
    const sources: HmrDiscoverySource[] = [
      { kind: "facet", name: "a", module: { id: "a", entry: "a.ts", accepts: ["a.ts"] } },
      {
        kind: "package",
        name: "pkg",
        modules: [
          { id: "b", entry: "b.ts" },
          { id: "c", entry: "c.ts" },
        ],
      },
    ];
    expect(discoverHmrUnits(sources).map((unit) => unit.id)).toEqual(["a", "b", "c"]);
    const narrowed = discoverHmrUnits([
      {
        kind: "package",
        name: "pkg",
        modules: [{ id: "b", entry: "b.ts" }],
        accepts: (unit) => unit.id === "b",
      },
    ]);
    expect(narrowed.map((unit) => unit.id)).toEqual(["b"]);
    expect(() =>
      discoverHmrUnits([{ kind: "facet", name: "x", module: { id: "x" } as never }])
    ).toThrow("UNSUPPORTED_DISCOVERY_ENTRY");
    expect(() => discoverHmrUnits([{ id: "a", entry: "a.ts" }, { id: "a", entry: "a2.ts" }])).toThrow(
      "DUPLICATE_HMR_UNIT"
    );
  });
});
