import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { resolveDataDir } from "./runtime";

describe("运行时数据目录", () => {
  test("默认落在 home 下的 .zeta-agent/", () => {
    const dir = resolveDataDir(join(tmpdir(), "zeta-home"));
    expect(isAbsolute(dir)).toBe(true);
    expect(basename(dir)).toBe(".zeta-agent");
  });

  test("支持覆盖 home 与自定义目录名", () => {
    const dir = resolveDataDir(join(tmpdir(), "zeta-home"), ".custom");
    expect(isAbsolute(dir)).toBe(true);
    expect(basename(dir)).toBe(".custom");
  });
});
