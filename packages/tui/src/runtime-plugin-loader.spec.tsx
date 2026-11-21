import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { testRender, useRenderer } from "@opentui/solid";
import type { SolidPlugin } from "@opentui/solid";
import {
  ensureRuntimePluginSupport,
  createRuntimePlugin,
  loadRuntimePlugin,
  type RuntimePluginError,
} from "./runtime-plugin-loader";
import {
  createSolidSlotRegistry,
  createSlot,
  type SolidSlotRegistry,
} from "./slots-native";
import { BANNER_MARKER, type BannerSlots } from "./__fixtures__/banner-plugin";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function BannerApp(props: {
  readonly registry: SolidSlotRegistry<BannerSlots>;
}) {
  const Slot = createSlot<BannerSlots>(props.registry);
  return (
    <box flexDirection="column">
      <Slot name="banner" mode="replace">
        <text>BASE_UI</text>
      </Slot>
    </box>
  );
}

test("IF-01: ensureRuntimePluginSupport 返回可用状态且幂等", () => {
  const first = ensureRuntimePluginSupport();
  const second = ensureRuntimePluginSupport();
  expect(first).toBe(true);
  expect(second).toBe(true);
});

test("IF-02: createRuntimePlugin 返回可用的 BunPlugin", () => {
  const plugin = createRuntimePlugin();
  expect(typeof plugin.name).toBe("string");
  expect(typeof plugin.setup).toBe("function");
});

test("IF-02: loadRuntimePlugin 运行时加载 TSX SolidPlugin 并返回默认导出", async () => {
  ensureRuntimePluginSupport();
  const plugin = await loadRuntimePlugin<SolidPlugin<BannerSlots>>(
    fileURLToPath(new URL("./__fixtures__/banner-plugin.tsx", import.meta.url)),
  );
  expect(plugin.id).toBe("runtime-banner-plugin");
  expect(typeof plugin.slots.banner).toBe("function");
});

test("AC-01: 加载后 Slot UI 可见、热卸载后恢复、坏插件保留旧 UI", async () => {
  ensureRuntimePluginSupport();

  let registry!: SolidSlotRegistry<BannerSlots>;
  function Harness() {
    const renderer = useRenderer();
    registry = createSolidSlotRegistry<BannerSlots>(renderer, {});
    return <BannerApp registry={registry} />;
  }

  const setup = await testRender(() => <Harness />, { width: 40, height: 4 });
  try {
    await setup.waitForFrame((frame) => frame.includes("BASE_UI"));

    const plugin = await loadRuntimePlugin<SolidPlugin<BannerSlots>>(
      fileURLToPath(new URL("./__fixtures__/banner-plugin.tsx", import.meta.url)),
    );
    registry.register(plugin);
    await setup.waitForFrame((frame) => frame.includes(BANNER_MARKER));

    registry.unregister(plugin.id);
    const restored = await setup.waitForFrame((frame) => frame.includes("BASE_UI"));
    expect(restored).not.toContain(BANNER_MARKER);

    registry.register(plugin);
    await setup.waitForFrame((frame) => frame.includes(BANNER_MARKER));

    const broken = await loadRuntimePlugin<SolidPlugin<BannerSlots>>(
      fileURLToPath(new URL("./__fixtures__/broken-plugin.tsx", import.meta.url)),
    );
    registry.register(broken);
    await setup.waitForFrame((frame) => frame.includes(BANNER_MARKER));
    expect(setup.captureCharFrame()).not.toContain("BASE_UI");
    expect(registry.getPluginErrors().length).toBeGreaterThan(0);
  } finally {
    setup.renderer.destroy();
  }
});

test("IF-02: loadRuntimePlugin 加载失败抛 PLUGIN_LOAD_FAILED", async () => {
  ensureRuntimePluginSupport();
  let error: RuntimePluginError | undefined;
  try {
    await loadRuntimePlugin(
      fileURLToPath(new URL("./__fixtures__/__missing_plugin__.tsx", import.meta.url)),
    );
  } catch (caught) {
    error = caught as RuntimePluginError;
  }
  expect(error).toBeDefined();
  expect(error?.code).toBe("PLUGIN_LOAD_FAILED");
});
