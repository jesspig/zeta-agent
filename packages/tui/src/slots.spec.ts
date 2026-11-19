import { describe, expect, test } from "bun:test";
import { ZETA_SLOT_NAMES, createSlotRegistry, type ZetaSlots } from "./slots";

describe("T-27 plugin slot registry", () => {
  test("declared slot names cover the merged slot table", () => {
    const names: readonly (keyof ZetaSlots)[] = [
      "header",
      "footer",
      "message",
      "tool",
      "editor",
      "overlay",
      "hud",
    ];
    for (const name of names) {
      expect(ZETA_SLOT_NAMES).toContain(name);
    }
  });

  test("hot swap replaces a contribution and disposes restore the previous one", () => {
    const registry = createSlotRegistry();
    const first = registry.register("footer", "alpha");
    expect(registry.render("footer")).toBe("alpha");

    const second = registry.register("footer", "beta");
    expect(registry.render("footer")).toBe("beta");

    second.dispose();
    expect(registry.render("footer")).toBe("alpha");

    first.dispose();
    expect(registry.render("footer")).toBe("");
    first.dispose();
    expect(registry.render("footer")).toBe("");
  });

  test("registering an undeclared slot throws", () => {
    const registry = createSlotRegistry();
    expect(() => registry.register("bogus" as never, "x")).toThrow();
  });
});
