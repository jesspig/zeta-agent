import { describe, expect, test } from "bun:test";
import { createSeam, provide, resolve, resolveOptional } from "./index";

/** 补审 CR-S01：必需 resolve 缺失时应明确失败，可选查询返回 undefined。 */
describe("T-42 Seam 缺失 provider", () => {
  test("已提供时 resolve 与 resolveOptional 都返回值", () => {
    const seam = createSeam<number>("cfg", "n");
    const stop = provide(seam, 42);
    expect(resolve(seam)).toBe(42);
    expect(resolveOptional(seam)).toBe(42);
    stop();
  });

  test("未提供时 resolve 抛错，resolveOptional 返回 undefined", () => {
    const seam = createSeam<number>("cfg2", "n");
    expect(() => resolve(seam)).toThrow(/SEAM_NOT_PROVIDED/);
    expect(resolveOptional(seam)).toBeUndefined();
  });
});
