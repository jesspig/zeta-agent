import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { ZetaApp } from "./runtime";
import type { SolidPlugin, ZetaNativeSlots } from "./slots-native";

test("U-10 生产 App 挂载官方 Solid 槽位：插件替换 footer 生效", async () => {
  const plugin: SolidPlugin<ZetaNativeSlots> = {
    id: "custom-footer",
    slots: {
      footer: () => <text>PLUGIN_FOOTER_MARKER</text>,
    },
  };
  const setup = await testRender(
    () => (
      <ZetaApp
        title="zeta"
        messages={[]}
        onPush={() => {}}
        onExit={() => {}}
        plugins={[plugin]}
      />
    ),
    { width: 60, height: 12 },
  );
  try {
    await setup.waitForFrame((frame) => frame.includes("PLUGIN_FOOTER_MARKER"));
    expect(setup.captureCharFrame()).toContain("PLUGIN_FOOTER_MARKER");
  } finally {
    setup.renderer.destroy();
  }
});

test("U-10 无插件时渲染基础 footer", async () => {
  const setup = await testRender(
    () => <ZetaApp title="zeta" messages={[]} onPush={() => {}} onExit={() => {}} />,
    { width: 60, height: 12 },
  );
  try {
    await setup.waitForFrame((frame) => frame.includes("zeta"));
    expect(setup.captureCharFrame()).not.toContain("PLUGIN_FOOTER_MARKER");
  } finally {
    setup.renderer.destroy();
  }
});
