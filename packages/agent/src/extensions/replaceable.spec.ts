import { describe, expect, test } from "bun:test";
import { resolveReplaceable, type Replaceable } from "./replaceable";

function spec<T>(name: string, replaceable: boolean, value: T): Replaceable<T> {
  return { name, replaceable, value };
}

describe("T-13 replaceable 语义", () => {
  test("可替换内置项被第三方整包接管，不可替换项拒绝接管", () => {
    const builtins = [spec("banner", true, "builtin-banner"), spec("core", false, "builtin-core")];
    const extras = [
      spec("banner", true, "third-banner"),
      spec("new", true, "third-new"),
      spec("core", true, "hijack"),
    ];

    const result = resolveReplaceable(builtins, extras);

    expect(result.active).toEqual(["third-banner", "builtin-core", "third-new"]);
    expect(result.replaced).toContain("banner");
    expect(result.rejected).toContain("core");
  });

  test("同名第三方之间后到者替换先到者，保持顺序稳定", () => {
    const result = resolveReplaceable<string>([], [
      spec("first", true, "a"),
      spec("first", true, "b"),
      spec("second", false, "c"),
    ]);

    expect(result.active).toEqual(["b", "c"]);
    expect(result.replaced).toContain("first");
  });

  test("无第三方时原样返回内置项", () => {
    const result = resolveReplaceable([spec("core", false, "x")], []);
    expect(result.active).toEqual(["x"]);
    expect(result.replaced).toHaveLength(0);
    expect(result.rejected).toHaveLength(0);
  });
});
