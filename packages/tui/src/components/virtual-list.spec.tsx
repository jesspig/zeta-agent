import { describe, expect, test } from "bun:test";
import { VirtualList } from "./virtual-list";

async function probeNative(): Promise<boolean> {
  try {
    const solid = await import("@opentui/solid");
    return typeof solid.testRender === "function";
  } catch {
    return false;
  }
}

const nativeAvailable = await probeNative();

describe.skipIf(!nativeAvailable)("T-23 virtual list budget (native conditional)", () => {
  test("10k entries render only the visible slice", async () => {
    const { testRender } = await import("@opentui/solid");
    const items = Array.from({ length: 10_000 }, (_, index) => `line-${index}`);
    let rendered = 0;
    const setup = await testRender(
      () => (
        <VirtualList
          items={items}
          estimateHeight={() => 1}
          viewportHeight={12}
          scrollTop={5_000}
          overscan={2}
          onRenderItem={() => { rendered += 1; }}
        >
          {(item) => <text>{item}</text>}
        </VirtualList>
      ),
      { width: 60, height: 12 },
    );
    try {
      const started = performance.now();
      await setup.renderOnce();
      const elapsed = performance.now() - started;
      const frame = setup.captureCharFrame();
      expect(rendered).toBeGreaterThan(0);
      expect(rendered).toBeLessThanOrEqual(20);
      expect(frame).toContain("line-5000");
      expect(frame).not.toContain("line-100");
      expect(elapsed).toBeLessThan(2_000);
    } finally {
      setup.renderer.destroy();
    }
  });

  test("variable heights select a different window than a fixed estimate", async () => {
    const { testRender } = await import("@opentui/solid");
    const items = Array.from({ length: 200 }, (_, index) => `row-${index}`);
    const heightOf = (index: number): number => (index % 5 === 0 ? 4 : 1);
    const seen: string[] = [];
    const setup = await testRender(
      () => (
        <VirtualList
          items={items}
          estimateHeight={(_item, index) => heightOf(index)}
          viewportHeight={6}
          scrollTop={40}
          overscan={0}
          onRenderItem={(item) => seen.push(item)}
        >
          {(item) => <text>{item}</text>}
        </VirtualList>
      ),
      { width: 40, height: 6 },
    );
    try {
      await setup.renderOnce();
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.length).toBeLessThan(12);
      expect(seen.every((item) => item.startsWith("row-"))).toBe(true);
    } finally {
      setup.renderer.destroy();
    }
  });
});
