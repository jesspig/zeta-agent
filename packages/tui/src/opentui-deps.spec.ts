import { expect, test } from "bun:test";

test("OpenTUI SolidJS 依赖可用（testRender + solid-js 可解析）", async () => {
  const solid = await import("@opentui/solid");
  expect(typeof solid.testRender).toBe("function");
  const jsx = await import("solid-js");
  expect(typeof jsx.createSignal).toBe("function");
});
