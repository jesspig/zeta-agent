import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { testRender } from "@opentui/solid";
import { ThemeProvider } from "../theme-context";
import { ModelPicker } from "./model-picker";
import type { RuntimeModelOption } from "../runtime-types";

const MODELS: readonly RuntimeModelOption[] = [
  { value: "m1", name: "M1", effort: ["low", "medium", "high"], group: "g" },
  { value: "m2", name: "M2", effort: [], group: "g" },
];

/** CR-12：调整档位后取消不应改变宿主的思考强度。 */
test("取消选择不提交暂存的推理档位", async () => {
  const [effort, setEffort] = createSignal<string | undefined>("medium");
  const setup = await testRender(
    () => (
      <ThemeProvider initial="dark">
        <ModelPicker
          models={MODELS}
          current="m1"
          effort={effort()}
          onSelect={() => {}}
          onEffort={(v) => setEffort(v)}
          onCancel={() => {}}
        />
      </ThemeProvider>
    ),
    { width: 100, height: 20 },
  );
  try {
    await setup.renderOnce();
    setup.mockInput.pressArrow("right");
    await setup.waitForFrame((f) => f.includes("High"));
    // 取消（Esc）不应落地档位
    setup.mockInput.pressEscape();
    await new Promise((r) => setTimeout(r, 50));
    expect(effort()).toBe("medium");
  } finally {
    setup.renderer.destroy();
  }
});
