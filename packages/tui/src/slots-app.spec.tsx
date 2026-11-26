import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import type { SolidPlugin, ZetaNativeSlots } from "./slots-native";
import { ZETA_NATIVE_SLOT_NAMES } from "./slots-native";
import { ZetaApp, createZetaAppElement, renderTui, type ZetaAppDeps } from "./runtime";
import { createOscReporter } from "./osc";
import type { RendererBackend } from "./backend";
import type { RuntimeTuiOptions } from "./runtime-types";

const noop = () => {};

function allSlotsPlugin(): SolidPlugin<ZetaNativeSlots> {
  const slots: Record<string, unknown> = {};
  for (const name of ZETA_NATIVE_SLOT_NAMES) {
    slots[String(name)] = () => <text>{`SLOT_${String(name).toUpperCase()}`}</text>;
  }
  return { id: "all-seven-slots", slots } as unknown as SolidPlugin<ZetaNativeSlots>;
}

test("完整 App 七个槽位全部接线：插件 replace 后七个标记都出现", async () => {
  const setup = await testRender(
    () => (
      <ZetaApp
        title="zeta"
        messages={[]}
        onPush={noop}
        onExit={noop}
        plugins={[allSlotsPlugin()]}
      />
    ),
    { width: 90, height: 20 },
  );
  try {
    await setup.waitForFrame((frame) => ZETA_NATIVE_SLOT_NAMES.every((name) =>
      frame.includes(`SLOT_${String(name).toUpperCase()}`)));
    const frame = setup.captureCharFrame();
    for (const name of ZETA_NATIVE_SLOT_NAMES) {
      expect(frame).toContain(`SLOT_${String(name).toUpperCase()}`);
    }
  } finally {
    setup.renderer.destroy();
  }
});

test("native/custom backend 共用同一完整 App 工厂", async () => {
  const options: RuntimeTuiOptions = { title: "zeta", messages: [], plugins: [allSlotsPlugin()] };
  const [bindings, setBindings] = createSignal([] as never[]);
  const deps: ZetaAppDeps = {
    onPush: noop,
    onEditorHandle: noop,
    approvalUi: {
      channel: { request: async () => { throw new Error("unused"); } },
      pending: () => undefined,
      respond: noop,
    },
    onSubmit: () => false,
    onExit: noop,
    modelList: () => [],
    currentModel: () => undefined,
    telemetry: () => undefined,
    keyBindings: bindings,
    reporter: createOscReporter(noop),
  };
  const app = createZetaAppElement(options, deps);
  const setup = await testRender(() => app() as never, { width: 90, height: 20 });
  try {
    await setup.waitForFrame((frame) => frame.includes("SLOT_HEADER"));
    const frame = setup.captureCharFrame();
    for (const name of ZETA_NATIVE_SLOT_NAMES) {
      expect(frame).toContain(`SLOT_${String(name).toUpperCase()}`);
    }
    setBindings([{ combo: "ctrl+d", action: "hot-exit", layer: "user" } as never]);
    await Bun.sleep(20);
  } finally {
    setup.renderer.destroy();
  }
});

test("自定义 backend 的 renderApp 收到完整 App 工厂并支持键位热更新", async () => {
  let captured: (() => unknown) | undefined;
  const backend: RendererBackend = {
    render: () => ({ snapshot: "" }),
    mount() {},
    input: () => false,
    event: () => () => {},
    resize() {},
    clipboard: { copy() {} },
    testRender: async () => ({
      renderOnce: async () => {},
      captureCharFrame: () => "",
      destroy() {},
    }),
    async renderApp(app) {
      captured = app;
      return { waitForExit: async () => {}, destroy: async () => {} };
    },
    destroy() {},
  };
  const handle = await renderTui({
    title: "zeta",
    messages: [],
    plugins: [allSlotsPlugin()],
    backend,
  });
  expect(typeof captured).toBe("function");
  expect(typeof handle.setKeyBindings).toBe("function");
  handle.setKeyBindings?.([{ combo: "ctrl+d", action: "hot-exit", layer: "user" }]);
  const setup = await testRender(() => (captured as () => unknown)() as never, {
    width: 90,
    height: 20,
  });
  try {
    await setup.waitForFrame((frame) => frame.includes("SLOT_HEADER"));
    for (const name of ZETA_NATIVE_SLOT_NAMES) {
      expect(setup.captureCharFrame()).toContain(`SLOT_${String(name).toUpperCase()}`);
    }
  } finally {
    setup.renderer.destroy();
  }
});
