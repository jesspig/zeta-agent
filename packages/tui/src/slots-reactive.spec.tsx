import { expect, test } from "bun:test";
import { testRender, useRenderer } from "@opentui/solid";
import type { PluginErrorEvent, SolidPlugin } from "./slots-native";
import {
  createReactiveSlotHost,
  type ReactiveSlotHost,
  type ZetaNativeSlots,
} from "./slots-reactive";

type Slots = ZetaNativeSlots;

function plugin(id: string, label: string): SolidPlugin<Slots> {
  const text = () => <text>{label}</text>;
  return { id, slots: { footer: text } };
}

function brokenPlugin(id: string): SolidPlugin<Slots> {
  return {
    id,
    slots: {
      footer: () => {
        throw new Error(`PLUGIN_RENDER_FAILED: ${id}`);
      },
    },
  };
}

test("生产 slots 响应式：register/unregister/onCleanup 与 A→B→A 热替换", async () => {
  let host!: ReactiveSlotHost<Slots>;
  const errors: PluginErrorEvent[] = [];

  function Harness() {
    const renderer = useRenderer();
    host = createReactiveSlotHost<Slots>(renderer);
    host.onPluginError((event) => errors.push(event));
    const BoundSlot = host.BoundSlot;
    return (
      <box flexDirection="column">
        <BoundSlot name="footer" mode="replace">
          <text>BASE</text>
        </BoundSlot>
      </box>
    );
  }

  const setup = await testRender(() => <Harness />, { width: 30, height: 3 });
  try {
    await setup.waitForFrame((frame) => frame.includes("BASE"));

    const a = plugin("A", "PLUGIN_A");
    const b = plugin("B", "PLUGIN_B");
    host.register(a);
    await setup.waitForFrame((frame) => frame.includes("PLUGIN_A"));
    expect(host.activeIds()).toEqual(["A"]);

    host.apply([b]);
    await setup.waitForFrame((frame) => frame.includes("PLUGIN_B"));
    expect(host.activeIds()).toEqual(["B"]);

    host.apply([a]);
    await setup.waitForFrame((frame) => frame.includes("PLUGIN_A"));
    expect(host.activeIds()).toEqual(["A"]);

    expect(host.unregister("A")).toBe(true);
    await setup.waitForFrame((frame) => frame.includes("BASE"));
    expect(host.activeIds()).toEqual([]);
  } finally {
    setup.renderer.destroy();
  }
  host.dispose();
  expect(() => host.register(plugin("C", "PLUGIN_C"))).toThrow(/dispose/i);
});

test("坏插件回退：渲染失败保留基础内容并记录错误", async () => {
  let host!: ReactiveSlotHost<Slots>;
  const errors: PluginErrorEvent[] = [];

  function Harness() {
    const renderer = useRenderer();
    host = createReactiveSlotHost<Slots>(renderer);
    host.onPluginError((event) => errors.push(event));
    const BoundSlot = host.BoundSlot;
    return (
      <box flexDirection="column">
        <BoundSlot name="footer" mode="replace">
          <text>BASE_FALLBACK</text>
        </BoundSlot>
      </box>
    );
  }

  const setup = await testRender(() => <Harness />, { width: 30, height: 3 });
  try {
    await setup.waitForFrame((frame) => frame.includes("BASE_FALLBACK"));
    const result = host.apply([plugin("GOOD", "GOOD_CONTENT")]);
    expect(result.ok).toBe(true);
    await setup.waitForFrame((frame) => frame.includes("GOOD_CONTENT"));

    host.apply([brokenPlugin("BAD")]);
    await setup.waitForFrame((frame) => frame.includes("BASE_FALLBACK"));
    expect(errors.some((event) => event.pluginId === "BAD")).toBe(true);
    expect(host.activeIds()).toEqual(["GOOD"]);
  } finally {
    setup.renderer.destroy();
  }
});
