import { describe, expect, test } from "bun:test";
import { testRender, type JSX } from "@opentui/solid";
import {
  ConfigSelector,
  ExtensionSelector,
  LoginDialog,
  ModelSelector,
  ScopedModelsSelector,
  SelectDialog,
  SessionSelector,
  SettingsSelector,
  ThemeSelector,
  ThinkingSelector,
  TreeSelector,
  TrustSelector,
  type DerivedSelectorProps,
  type SelectOption,
} from "./selectors";

const OPTIONS: readonly SelectOption[] = [
  { value: "alpha", label: "Alpha One", description: "first" },
  { value: "beta", label: "Beta Two", description: "second" },
  { value: "gamma", label: "Gamma Three", description: "third" },
];

type SelectorComponent = (props: DerivedSelectorProps) => JSX.Element;

const CASES: readonly {
  readonly name: string;
  readonly Component: SelectorComponent;
  readonly title: string;
}[] = [
  { name: "ModelSelector", Component: ModelSelector, title: "选择模型" },
  { name: "SettingsSelector", Component: SettingsSelector, title: "设置" },
  { name: "ThinkingSelector", Component: ThinkingSelector, title: "思考模式" },
  { name: "ScopedModelsSelector", Component: ScopedModelsSelector, title: "作用域模型" },
  { name: "TreeSelector", Component: TreeSelector, title: "选择节点" },
  { name: "SessionSelector", Component: SessionSelector, title: "会话" },
  { name: "ThemeSelector", Component: ThemeSelector, title: "主题" },
  { name: "LoginDialog", Component: LoginDialog, title: "登录" },
  { name: "TrustSelector", Component: TrustSelector, title: "信任" },
  { name: "ExtensionSelector", Component: ExtensionSelector, title: "扩展" },
  { name: "ConfigSelector", Component: ConfigSelector, title: "配置" },
];

function rowWidths(frame: string): number[] {
  const lines = frame.split("\n");
  return lines.slice(0, -1).map((line) => line.length);
}

describe("T-03 选择器/对话框族", () => {
  for (const { name, Component, title } of CASES) {
    test(`${name}：打开并渲染标题与选项`, async () => {
      const setup = await testRender(
        () => (
          <Component
            options={OPTIONS}
            onSelect={() => {}}
            onCancel={() => {}}
          />
        ),
        { width: 36, height: 10 },
      );
      try {
        await setup.waitForFrame((frame) => frame.includes("Alpha One"));
        const frame = setup.captureCharFrame();
        expect(frame).toContain(title);
        expect(frame).toContain("Alpha One");
        expect(frame).toContain("Beta Two");
      } finally {
        setup.renderer.destroy();
      }
    });

    test(`${name}：输入搜索过滤选项`, async () => {
      const setup = await testRender(
        () => (
          <Component
            options={OPTIONS}
            onSelect={() => {}}
            onCancel={() => {}}
          />
        ),
        { width: 36, height: 10 },
      );
      try {
        await setup.waitForFrame((frame) => frame.includes("Alpha One"));
        setup.mockInput.typeText("Beta");
        await setup.waitForFrame((frame) => !frame.includes("Alpha One"));
        const frame = setup.captureCharFrame();
        expect(frame).toContain("Beta Two");
        expect(frame).not.toContain("Gamma Three");
      } finally {
        setup.renderer.destroy();
      }
    });

    test(`${name}：上下键选择 + Enter 确认`, async () => {
      const selected: SelectOption[] = [];
      const setup = await testRender(
        () => (
          <Component
            options={OPTIONS}
            onSelect={(option) => { selected.push(option); }}
            onCancel={() => {}}
          />
        ),
        { width: 36, height: 10 },
      );
      try {
        await setup.waitForFrame((frame) => frame.includes("> Alpha One"));
        setup.mockInput.pressArrow("down");
        await setup.waitForFrame((frame) => frame.includes("> Beta Two"));
        setup.mockInput.pressEnter();
        await setup.waitForFrame(() => selected.length === 1);
        expect(selected[0]?.value).toBe("beta");
      } finally {
        setup.renderer.destroy();
      }
    });

    test(`${name}：Escape 取消`, async () => {
      let cancelled = false;
      const setup = await testRender(
        () => (
          <Component
            options={OPTIONS}
            onSelect={() => {}}
            onCancel={() => { cancelled = true; }}
          />
        ),
        { width: 36, height: 10 },
      );
      try {
        await setup.waitForFrame((frame) => frame.includes("Alpha One"));
        setup.mockInput.pressEscape();
        await Bun.sleep(30); // ESC 原始终端序列需短暂缓冲窗口
        await setup.waitForFrame(() => cancelled);
        expect(cancelled).toBe(true);
      } finally {
        setup.renderer.destroy();
      }
    });
  }

  test("SelectDialog：NFR-02 每行宽度不超终端宽度", async () => {
    const long = Array.from({ length: 8 }, (_, i) => ({
      value: `v${i}`,
      label: `超长选项标签-${i}-`.repeat(10),
    }));
    const setup = await testRender(
      () => (
        <SelectDialog
          title="宽度测试"
          options={long}
          onSelect={() => {}}
          onCancel={() => {}}
          width={20}
        />
      ),
      { width: 24, height: 12 },
    );
    try {
      await setup.waitForFrame((frame) => frame.includes("宽度测试"));
      const widths = rowWidths(setup.captureCharFrame());
      expect(widths.length).toBeGreaterThan(0);
      expect(Math.max(...widths)).toBeLessThanOrEqual(24);
    } finally {
      setup.renderer.destroy();
    }
  });
});
