import { describe, expect, test } from "bun:test";
import {
  alternateScreenSequence,
  bracketedPasteSequence,
  createPtySession,
  cursorKeyResetSequence,
  detectCapability,
  kittyKeyboardSequence,
  mouseTrackingSequence,
  resizeSequence,
  type SupportedPlatform,
} from "./pty";

import { checkPtyResult, runPtyScenario, type PtyScenarioResult } from "./pty-real";

const platforms: readonly SupportedPlatform[] = ["win32", "darwin", "linux"];

describe("T-23 platform capability matrix", () => {
  for (const platform of platforms) {
    test(`${platform} reports stable capability flags`, () => {
      const cap = detectCapability({ platform, env: {}, nativeAvailable: true, ptyAvailable: true });
      expect(cap.platform).toBe(platform);
      expect(cap.nativeAvailable).toBe(true);
      expect(cap.ptyAvailable).toBe(true);
      expect(cap.skipNativeTests).toBe(false);
      expect(cap.headlessSafe).toBe(true);
    });
  }

  test("native/PTY absence only skips native tests, never the headless path", () => {
    const cap = detectCapability({
      platform: "win32",
      env: {},
      nativeAvailable: false,
      ptyAvailable: false,
    });
    expect(cap.skipNativeTests).toBe(true);
    expect(cap.headlessSafe).toBe(true);
    expect(detectCapability({ platform: "linux", env: {}, nativeAvailable: true, ptyAvailable: false }).skipNativeTests).toBe(true);
    expect(detectCapability({ platform: "darwin", env: {}, nativeAvailable: false, ptyAvailable: true }).skipNativeTests).toBe(true);
  });

  test("TERM_PROGRAM/COLORTERM are recorded without enabling native implicitly", () => {
    const cap = detectCapability({
      platform: "linux",
      env: { TERM_PROGRAM: "iTerm.app", COLORTERM: "truecolor" },
      nativeAvailable: false,
      ptyAvailable: false,
    });
    expect(cap.termProgram).toBe("iTerm.app");
    expect(cap.colorTerminal).toBe(true);
    expect(cap.nativeAvailable).toBe(false);
  });
});

describe("T-23 PTY control sequences and session lifecycle", () => {
  test("alternate-screen enter/exit sequences are symmetric", () => {
    expect(alternateScreenSequence("enter")).toBe("\x1b[?1049h");
    expect(alternateScreenSequence("exit")).toBe("\x1b[?1049l");
  });

  test("resize/cursor/key/mouse/paste sequences are platform independent", () => {
    expect(resizeSequence({ width: 120, height: 40 })).toBe("\x1b[8;40;120t");
    expect(cursorKeyResetSequence()).toContain("\x1b[?1l");
    expect(mouseTrackingSequence(true)).toBe("\x1b[?1000h\x1b[?1006h");
    expect(mouseTrackingSequence(false)).toBe("\x1b[?1000l\x1b[?1006l");
    expect(kittyKeyboardSequence(true)).toBe("\x1b[>1u");
    expect(kittyKeyboardSequence(false)).toBe("\x1b[<u");
    expect(bracketedPasteSequence(true)).toBe("\x1b[?2004h");
    expect(bracketedPasteSequence(false)).toBe("\x1b[?2004l");
  });

  test("normal enter/resize/exit emits enter then protocols then restore", () => {
    const session = createPtySession();
    expect(session.state()).toBe("main");
    session.enter();
    expect(session.state()).toBe("alternate");
    session.resize({ width: 100, height: 30 });
    const output = session.output();
    expect(output.startsWith("\x1b[?1049h")).toBe(true);
    expect(output).toContain("\x1b[8;30;100t");
    session.exit();
    expect(session.state()).toBe("restored");
    expect(session.output().endsWith("\x1b[?1049l")).toBe(true);
    expect(session.output()).toContain("\x1b[?1000l");
  });

  test("abnormal exit restores terminal exactly once and can be reset", () => {
    const session = createPtySession();
    session.enter();
    session.abnormalExit();
    expect(session.state()).toBe("abnormal");
    const recovered = session.output();
    expect(recovered).toContain("\x1b[?1049l");
    session.abnormalExit();
    expect(session.output()).toBe(recovered);
    session.reset();
    expect(session.state()).toBe("main");
    expect(session.output()).toBe("");
  });

  test("invalid lifecycle transitions are rejected", () => {
    const session = createPtySession();
    expect(() => session.exit()).toThrow("PTY_STATE");
    session.enter();
    expect(() => session.enter()).toThrow("PTY_STATE");
    session.exit();
    expect(() => session.resize({ width: 10, height: 10 })).toThrow("PTY_STATE");
  });
});

describe("T-23 真实 PTY 集成（本机必过，不 skip、不合成 escape 序列）", () => {
  const expectRealPty = (result: PtyScenarioResult): void => {
    const failures = checkPtyResult(result);
    expect(failures).toEqual([]);
  };

  test("真实启动 TUI：退出码 0 + 备用屏 + raw 模式标记", async () => {
    const result = await runPtyScenario("normal");
    expectRealPty(result);
    expect(result.enteredAlternate).toBe(true);
    expect(result.restoredAlternate).toBe(true);
    expect(result.rawModeMarkers).toBe(true);
  }, 15_000);

  test("真实 PTY resize：window-change 上报被真实子进程确认", async () => {
    const result = await runPtyScenario("resize");
    expectRealPty(result);
    expect(result.resizeSequence).toBe(true);
  }, 15_000);

  test("真实 PTY 异常恢复：运行期异常后完整 App 仍复位终端", async () => {
    const result = await runPtyScenario("abnormal");
    expectRealPty(result);
    expect(result.exitCode).toBe(1);
    expect(result.restoredAlternate).toBe(true);
  }, 15_000);
});
