import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { ZetaApp } from "./runtime";

/** CR-11：/model <id> 必须能从动态发现的 modelList 中直接选择。 */
describe("T-11 模型命令与动态列表", () => {
  test("/model 直接选择 discovered 列表中的模型并回调宿主", async () => {
    let chosen: string | undefined;
    const setup = await testRender(
      () => (
        <ZetaApp
          title="zeta"
          messages={[]}
          onPush={() => {}}
          onSubmit={() => {}}
          onExit={() => {}}
          modelList={[
            { value: "m1", name: "M1" },
            { value: "m2", name: "M2" },
          ]}
          currentModel="m1"
          onModelChange={(v) => { chosen = v; }}
        />
      ),
      { width: 80, height: 20 },
    );
    try {
      await setup.renderOnce();
      setup.mockInput.typeText("/model m2");
      await setup.waitForFrame((f) => f.includes("/model m2"));
      setup.mockInput.pressEnter();
      await setup.waitForFrame(() => chosen === "m2");
      expect(chosen).toBe("m2");
    } finally {
      setup.renderer.destroy();
    }
  });
});
