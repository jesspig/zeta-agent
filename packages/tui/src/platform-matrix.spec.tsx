import { describe, expect, test } from "bun:test";
import { createBackendKeyEvent, createTui, type RendererBackend } from "./backend";
import type { FrameState } from "./frame-state";
import { isImeCompositionKey } from "./keymap";
import {
  bracketedPasteSequence,
  detectCapability,
  kittyKeyboardSequence,
  mouseTrackingSequence,
  type SupportedPlatform,
} from "./pty";
import {
  createOscReporter,
  extractMarkdownLinks,
  oscCopySelection,
  oscHyperlink,
  oscPromptMark,
  oscSequence,
} from "./osc";

async function probeNative(): Promise<boolean> {
  try {
    const solid = await import("@opentui/solid");
    const core = await import("@opentui/core");
    return typeof solid.testRender === "function" && typeof core.CliRenderer === "function";
  } catch {
    return false;
  }
}

const nativeAvailable = await probeNative();
const platforms: readonly SupportedPlatform[] = ["win32", "darwin", "linux"];

describe("T-23 OSC / clipboard platform matrix", () => {
  for (const platform of platforms) {
    test(`${platform} emits safe OSC 52/9;4/7501/133 sequences`, () => {
      const cap = detectCapability({ platform, env: {}, nativeAvailable: false, ptyAvailable: false });
      expect(cap.headlessSafe).toBe(true);
      const written: string[] = [];
      const reporter = createOscReporter((sequence) => written.push(sequence));
      reporter.copySelection("copy-中文");
      reporter.reportStatus("working");
      reporter.reportProgress(42);
      reporter.markPrompt("A");
      reporter.link("https://example.com/a?b=1");
      expect(written[0]).toBe(oscCopySelection("copy-中文"));
      expect(written[0]).toMatch(/^\x1b\]52;c;[A-Za-z0-9+/=]+\x1b\\$/);
      expect(written[1]).toBe(oscSequence("status", "working"));
      expect(written[2]).toBe("\x1b]7501;42\x1b\\");
      expect(written[3]).toBe(oscPromptMark("A"));
      expect(written[4]).toBe(oscHyperlink("https://example.com/a?b=1"));
      expect(() => reporter.link("javascript:alert(1)")).not.toThrow();
      expect(extractMarkdownLinks("[doc](https://example.com)")).toEqual(["https://example.com"]);
    });
  }
});

describe("T-23 mouse / paste / clipboard contract matrix", () => {
  for (const platform of platforms) {
    test(`${platform} exposes identical protocol toggles and backend clipboard`, () => {
      expect(mouseTrackingSequence(true)).toContain("\x1b[?1006h");
      expect(mouseTrackingSequence(false)).toContain("\x1b[?1006l");
      expect(bracketedPasteSequence(true)).toBe("\x1b[?2004h");
      expect(kittyKeyboardSequence(true)).toBe("\x1b[>1u");

      const copies: string[] = [];
      const backend: RendererBackend = {
        render: (frame: FrameState) => ({ snapshot: frame.lines.join("\n") }),
        mount: () => {},
        input: () => true,
        event: () => () => {},
        resize: () => {},
        clipboard: { copy: (text) => copies.push(text) },
        testRender: async () => ({ renderOnce: async () => {}, captureCharFrame: () => "", destroy: () => {} }),
        destroy: () => {},
      };
      const handle = createTui({ backend });
      handle.clipboard.copy("selected");
      expect(copies).toEqual(["selected"]);
      expect(createBackendKeyEvent({ name: "a" }).name).toBe("a");
      handle.destroy();
    });
  }
});

describe("T-23 IME composition guard", () => {
  for (const platform of platforms) {
    test(`${platform} suppresses key bindings while composing`, () => {
      const key = { name: "d", ctrl: true, isComposing: true };
      expect(isImeCompositionKey(key)).toBe(true);
      expect(isImeCompositionKey({ name: "d", ctrl: true })).toBe(false);
      expect(isImeCompositionKey({ name: "process", isComposing: true })).toBe(false);
    });
  }
});

describe("T-23 native overlay frame (conditional)", () => {
  test.skipIf(!nativeAvailable)("overlay renders and resizes without crashing native", async () => {
    const { testRender } = await import("@opentui/solid");
    const { ConfirmOverlay } = await import("./components/overlay");
    const setup = await testRender(() => <ConfirmOverlay message="确认退出" onConfirm={() => {}} onCancel={() => {}} />, {
      width: 60,
      height: 12,
    });
    try {
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("确认退出");
    } finally {
      setup.renderer.destroy();
    }
  });
});
