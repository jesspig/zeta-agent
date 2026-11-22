import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { testRender } from "@opentui/solid";
import { ThemeProvider } from "../theme-context";
import { ModelPicker } from "./model-picker";
import type { RuntimeModelOption } from "../runtime-types";

const MODELS: readonly RuntimeModelOption[] = [
  { value: "deepseek-v4", name: "DeepSeek V4", context: "1M", price: "$0.15/0.6", effort: ["low", "medium", "xhigh"], reasoning: true, group: "deepseek" },
  { value: "gpt-4o", name: "GPT-4o", context: "128K", price: "$2.5/10", effort: [], group: "openai" },
];

async function renderPicker() {
  const [effort, setEffort] = createSignal<string | undefined>("medium");
  let selected = "";
  const setup = await testRender(
    () => (
      <ThemeProvider initial="dark">
        <ModelPicker
          models={MODELS}
          current="deepseek-v4"
          effort={effort()}
          onSelect={(value) => { selected = value; }}
          onEffort={(next) => setEffort(next)}
          onCancel={() => {}}
        />
      </ThemeProvider>
    ),
    { width: 100, height: 20 },
  );
  return { setup, effort, selectedValue: () => selected };
}

test("模型选择器多列展示名称/上下文/价格", async () => {
  const { setup } = await renderPicker();
  try {
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("DeepSeek V4");
    expect(frame).toContain("1M");
    expect(frame).toContain("$0.15/0.6");
    expect(frame).toContain("思考强度");
  } finally {
    setup.renderer.destroy();
  }
});

test("右键调高思考强度先暂存显示，确认模型后才提交", async () => {
  const { setup, effort } = await renderPicker();
  try {
    await setup.renderOnce();
    expect(effort()).toBe("medium");
    setup.mockInput.pressArrow("right");
    await setup.waitForFrame((frame) => frame.includes("Extra High"));
    // 仅展示变化，宿主状态尚未提交
    expect(effort()).toBe("medium");
    // Enter 确认后提交
    setup.mockInput.pressEnter();
    await new Promise((r) => setTimeout(r, 30));
    expect(effort()).toBe("xhigh");
  } finally {
    setup.renderer.destroy();
  }
});

test("列表超出可视行时可滚动并选中末尾模型", async () => {
  const many: RuntimeModelOption[] = Array.from({ length: 20 }, (_, i) => ({
    value: `model-${i}`,
    name: `Model ${i}`,
    context: "1M",
    price: "$1/2",
    effort: [],
    group: "test",
  }));
  const setup = await testRender(
    () => (
      <ThemeProvider initial="dark">
        <ModelPicker
          models={many}
          current={undefined}
          effort={undefined}
          onSelect={() => {}}
          onEffort={() => {}}
          onCancel={() => {}}
        />
      </ThemeProvider>
    ),
    { width: 100, height: 20 },
  );
  try {
    await setup.renderOnce();
    // 连续下移超过 12 个可视行，滚动窗口应跟随，末尾模型可见。
    for (let i = 0; i < 19; i += 1) {
      setup.mockInput.pressArrow("down");
      await Bun.sleep(5);
    }
    await setup.waitForFrame((frame) => frame.includes("Model 19"));
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Model 19");
    expect(frame).toContain("/ 20");
  } finally {
    setup.renderer.destroy();
  }
});

test("搜索过滤模型列表", async () => {
  const { setup } = await renderPicker();
  try {
    await setup.renderOnce();
    setup.mockInput.typeText("gpt");
    await setup.waitForFrame((frame) => !frame.includes("DeepSeek V4"));
    expect(setup.captureCharFrame()).toContain("GPT-4o");
  } finally {
    setup.renderer.destroy();
  }
});
