import { describe, expect, test } from "bun:test";
import { createSlotRegistry } from "./slots";
import { createHotSlotHost, type SlotPlugin } from "./hot-reload";

function plugin(id: string, slots: Record<string, string>): SlotPlugin {
  return { id, slots };
}

describe("T-13 热加载槽位宿主（closure rule）", () => {
  test("apply 安装插件槽位并渲染", () => {
    const host = createHotSlotHost({ registry: createSlotRegistry() });
    const result = host.apply([plugin("banner", { footer: "BANNER" })]);

    expect(result.ok).toBe(true);
    expect(result.activeIds).toEqual(["banner"]);
    expect(host.render("footer")).toBe("BANNER");
  });

  test("apply 新集合替换旧集合，卸载旧内容", () => {
    const host = createHotSlotHost({ registry: createSlotRegistry() });
    host.apply([plugin("a", { footer: "A" })]);
    host.apply([plugin("b", { footer: "B" })]);

    expect(host.render("footer")).toBe("B");
    expect(host.current()).toEqual(["b"]);
  });

  test("失败回滚：非法槽位名不改变现有内容（closure rule）", () => {
    const host = createHotSlotHost({ registry: createSlotRegistry() });
    host.apply([plugin("good", { footer: "GOOD" })]);

    const result = host.apply([plugin("bad", { footer: "BAD", "not-a-slot": "X" })]);

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(host.render("footer")).toBe("GOOD");
    expect(host.current()).toEqual(["good"]);
  });
});
