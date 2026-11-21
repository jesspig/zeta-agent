import { expect, test } from "bun:test";
import { testRender, useRenderer } from "@opentui/solid";
import type { SolidPlugin } from "@opentui/solid";
import {
  createSolidSlotRegistry,
  createSlot,
  Slot,
  type SolidSlotRegistry,
} from "./slots-native";

type NativeSlots = {
  banner: object;
};

test("IF-03: createSolidSlotRegistry 返回官方注册表并可注册插件", async () => {
  let registry!: SolidSlotRegistry<NativeSlots>;
  let BoundSlot!: ReturnType<typeof createSlot<NativeSlots>>;

  function Harness() {
    const renderer = useRenderer();
    registry = createSolidSlotRegistry<NativeSlots>(renderer, {});
    BoundSlot = createSlot<NativeSlots>(registry);
    return (
      <box flexDirection="column">
        <BoundSlot name="banner" mode="replace">
          <text>BASE</text>
        </BoundSlot>
      </box>
    );
  }

  const setup = await testRender(() => <Harness />, { width: 40, height: 3 });
  try {
    await setup.waitForFrame((frame) => frame.includes("BASE"));

    const plugin: SolidPlugin<NativeSlots> = {
      id: "native-banner",
      slots: { banner: () => <text>NATIVE_OK</text> },
    };
    registry.register(plugin);
    await setup.waitForFrame((frame) => frame.includes("NATIVE_OK"));
  } finally {
    setup.renderer.destroy();
  }
});

test("IF-03: Slot 组件为官方导出的别名", () => {
  expect(typeof Slot).toBe("function");
});
