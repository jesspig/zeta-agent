import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { ZetaApp, ZetaFrame } from "./runtime";
import { ViewportLayout } from "./components/layout-view";
import { WorkIndicator } from "./components/status-border";

/** 取每一行的行号，便于断言上下分区与自适应宽度。 */
function lineAt(frame: string, marker: string): number {
  const index = frame.split("\n").findIndex((line) => line.includes(marker));
  if (index < 0) throw new Error(`帧中未找到标记: ${marker}`);
  return index;
}

function rowWidths(frame: string): number[] {
  const lines = frame.split("\n");
  // 末行为快照尾随换行产生的空串，排除。
  return lines.slice(0, -1).map((line) => line.length);
}

describe("T-02 视口布局重构", () => {
  test("RED-1 ViewportLayout：transcript 在上方且可滚（占据剩余高度），dock 固定停靠在下方", async () => {
    const setup = await testRender(
      () => (
        <ViewportLayout
          transcript={<ZetaFrame title="transcript" lines={["T-ROW-1", "T-ROW-2"]} />}
          dock={
            <box flexDirection="column">
              <text>DOCK-EDITOR</text>
              <text>DOCK-FOOTER</text>
            </box>
          }
        />
      ),
      { width: 30, height: 10 },
    );
    try {
      await setup.waitForFrame((frame) => frame.includes("T-ROW-1"));
      const frame = setup.captureCharFrame();
      const transcriptRow = lineAt(frame, "T-ROW-1");
      const editorRow = lineAt(frame, "DOCK-EDITOR");
      const footerRow = lineAt(frame, "DOCK-FOOTER");
      // 上层 transcript 必须先于下层 dock。
      expect(transcriptRow).toBeLessThan(editorRow);
      expect(editorRow).toBeLessThan(footerRow);
      // dock 紧贴底部：footer 位于倒数第二行（末行为尾随换行空串）。
      expect(footerRow).toBe(9);
      // 可滚 transcript 占据上方剩余高度：editor 与 transcript 之间留有填充行。
      expect(editorRow - transcriptRow).toBeGreaterThan(1);
    } finally {
      setup.renderer.destroy();
    }
  });

  test("RED-2 ViewportLayout：transcript 内容超出高度时保持有界滚动，不挤走 dock", async () => {
    const many = Array.from({ length: 30 }, (_, i) => `LINE-${String(i).padStart(2, "0")}`);
    const setup = await testRender(
      () => (
        <ViewportLayout
          transcript={<ZetaFrame title="transcript" lines={many} />}
          dock={
            <box flexDirection="column">
              <text>DOCK-EDITOR</text>
              <text>DOCK-FOOTER</text>
            </box>
          }
        />
      ),
      { width: 30, height: 8 },
    );
    try {
      await setup.waitForFrame((frame) => frame.includes("DOCK-EDITOR"));
      const frame = setup.captureCharFrame();
      // dock 仍在底部，未被大量 transcript 文本挤出屏幕。
      expect(lineAt(frame, "DOCK-FOOTER")).toBe(7);
      // transcript 可滚：最后一行消息可见，首行已滚出可视区。
      expect(frame).toContain("LINE-29");
      expect(frame).not.toContain("LINE-00");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("RED-3 ViewportLayout：resize 后宽度自适应且逐行不越界（NFR-02）", async () => {
    const setup = await testRender(
      () => (
        <ViewportLayout
          transcript={<ZetaFrame title="transcript" lines={["T-ROW"]} />}
          dock={
            <box flexDirection="column">
              <text>DOCK</text>
            </box>
          }
        />
      ),
      { width: 24, height: 6 },
    );
    try {
      await setup.waitForFrame((frame) => frame.includes("T-ROW"));
      const before = setup.captureCharFrame();
      expect(rowWidths(before).every((width) => width === 24)).toBe(true);

      setup.resize(40, 6);
      await setup.waitForFrame((frame) => frame.includes("T-ROW"));
      const after = setup.captureCharFrame();
      // resize 后所有行宽度自适应到新宽度，且没有任何行超过终端宽度。
      expect(rowWidths(after).every((width) => width === 40)).toBe(true);
      expect(Math.max(...rowWidths(after))).toBeLessThanOrEqual(40);
    } finally {
      setup.renderer.destroy();
    }
  });

  test("RED-4 WorkIndicator：编辑器上方的工作指示器带边框并反映状态", async () => {
    const setup = await testRender(() => <WorkIndicator status="working" />, {
      width: 20,
      height: 3,
    });
    try {
      await setup.waitForFrame((frame) => frame.includes("[working]"));
      const frame = setup.captureCharFrame();
      // 边框由 box border 产生（角/横线），且状态文本存在。
      expect(frame).toContain("[working]");
      expect(frame).toMatch(/[─╭╮╰╯|]/);
    } finally {
      setup.renderer.destroy();
    }
  });

  test("RED-5 ZetaApp 保持功能：消息、编辑器、footer 均落在两层布局中", async () => {
    const setup = await testRender(
      () => (
        <ZetaApp
          title="zeta"
          messages={[
            { role: "user", content: "hello-viewport" },
            { role: "assistant", content: "world-viewport" },
          ]}
          onPush={() => {}}
          onExit={() => {}}
        />
      ),
      { width: 30, height: 10 },
    );
    try {
      await setup.waitForFrame((frame) => frame.includes("hello-viewport"));
      const frame = setup.captureCharFrame();
      const messageRow = lineAt(frame, "hello-viewport");
      // 编辑器占位提示与 footer 位于消息下方（dock 区）。
      const editorRow = lineAt(frame, "输入消息");
      const footerRow = lineAt(frame, "zeta idle");
      expect(messageRow).toBeLessThan(editorRow);
      expect(editorRow).toBeLessThan(footerRow);
      expect(footerRow).toBe(9);
      // NFR-02：帧中每一行都不超过终端宽度。
      expect(Math.max(...rowWidths(frame))).toBeLessThanOrEqual(30);
    } finally {
      setup.renderer.destroy();
    }
  });

  test("RED-6 ZetaApp 提供 source 时富消息列表仍渲染于 transcript 上层", async () => {
    const source = { subscribe: () => () => {} };
    const setup = await testRender(
      () => (
        <ZetaApp title="zeta" messages={[]} source={source} onPush={() => {}} onExit={() => {}} />
      ),
      { width: 30, height: 10 },
    );
    try {
      await setup.waitForFrame((frame) => frame.includes("IDLE"));
      const frame = setup.captureCharFrame();
      const idleRow = lineAt(frame, "IDLE");
      const footerRow = lineAt(frame, "zeta idle");
      expect(idleRow).toBeLessThan(footerRow);
    } finally {
      setup.renderer.destroy();
    }
  });
});
