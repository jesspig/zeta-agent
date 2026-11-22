import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { ZetaApp } from "./runtime";

/** CR-04：/new 必须委托宿主做真实会话替换，而不只是清视图。 */
describe("T-04 /new 会话替换接线", () => {
  test("/new 调用宿主 onNewSession 回调", async () => {
    let called = 0;
    const setup = await testRender(
      () => (
        <ZetaApp
          title="zeta"
          messages={[]}
          onPush={() => {}}
          onSubmit={() => {}}
          onExit={() => {}}
          onNewSession={() => { called += 1; }}
        />
      ),
      { width: 80, height: 20 },
    );
    try {
      await setup.renderOnce();
      setup.mockInput.typeText("/new");
      await setup.waitForFrame((frame) => frame.includes("/new"));
      setup.mockInput.pressEnter();
      await setup.waitForFrame(() => called === 1);
      expect(called).toBe(1);
    } finally {
      setup.renderer.destroy();
    }
  });
});
