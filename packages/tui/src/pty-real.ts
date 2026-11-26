import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * T-23 真实 PTY harness（本地 fixture，不访问外网）。
 *
 * Bun.Terminal：POSIX=openpty，Windows=ConPTY。子进程看到真实 TTY，
 * 所有输出均来自被测进程的真实终端 I/O，不合成 escape 序列。
 * - normal / resize：真实 `zeta` TUI 入口；
 * - abnormal：真实 renderTui 完整 App 的运行期异常恢复。
 */

export const ALTERNATE_ENTER = "\x1b[?1049h";
export const ALTERNATE_EXIT = "\x1b[?1049l";
export const BRACKETED_PASTE_ON = "\x1b[?2004h";
export const MOUSE_TRACKING_ON = "\x1b[?1000h";
export const EXIT_KEY = "\x04"; // Ctrl+D：TUI app 层 exit 绑定

/** 无论从仓库根、包目录还是脚本目录调用，子进程都从 workspace 根启动。 */
export const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export type PtyScenario = "normal" | "resize" | "abnormal";

export const PTY_SCENARIOS: readonly PtyScenario[] = Object.freeze([
  "normal",
  "resize",
  "abnormal",
]);

export interface PtyScenarioResult {
  readonly scenario: PtyScenario;
  readonly exitCode: number | null;
  readonly raw: string;
  readonly platform: string;
  readonly enteredAlternate: boolean;
  readonly restoredAlternate: boolean;
  readonly rawModeMarkers: boolean;
  readonly resizeSequence: boolean;
  readonly abnormalFixture: boolean;
}

export interface PtyScenarioOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

interface TerminalLike {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

interface SpawnLike {
  readonly exited: Promise<number | null>;
  readonly terminal?: TerminalLike;
  kill(): void;
}

type SpawnFn = (
  cmd: string[],
  options: {
    readonly cwd: string;
    readonly env: Record<string, string | undefined>;
    readonly terminal: {
      readonly cols: number;
      readonly rows: number;
      data(terminal: TerminalLike, data: Uint8Array): void;
    };
  },
) => SpawnLike;

function commandsFor(scenario: PtyScenario): string[] {
  if (scenario === "abnormal") {
    return [
      process.execPath,
      "--preload",
      "@opentui/solid/preload",
      "packages/tui/src/__fixtures__/abnormal-exit-app.tsx",
    ];
  }
  return [process.execPath, "apps/zeta-cli/src/index.ts"];
}

export async function runPtyScenario(
  scenario: PtyScenario,
  options: PtyScenarioOptions = {},
): Promise<PtyScenarioResult> {
  if (!PTY_SCENARIOS.includes(scenario)) throw new Error(`UNKNOWN_PTY_SCENARIO: ${scenario}`);
  const cwd = options.cwd ?? WORKSPACE_ROOT;
  const timeoutMs = options.timeoutMs ?? 10_000;
  // Bun.Terminal 仅在 Bun 运行时可用；PTY 门与 spec 都由 bun 执行。
  const spawn = (Bun as unknown as { spawn: SpawnFn }).spawn;
  let raw = "";
  let proc: SpawnLike | undefined;
  let entered = false;
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  const killTimer = setTimeout(() => {
    try {
      proc?.kill();
    } catch {
      // 已退出
    }
  }, timeoutMs);

  try {
    proc = spawn(commandsFor(scenario), {
      cwd,
      env: {
        ...process.env,
        ZETA_BASE_URL: "",
        ZETA_API_KEY: "",
        ZETA_MODEL: "",
        ...options.env,
      },
      terminal: {
        cols: 100,
        rows: 30,
        data(_terminal, data) {
          raw += Buffer.from(data).toString("utf8");
          if (scenario === "abnormal" || entered || !raw.includes(ALTERNATE_ENTER)) return;
          entered = true;
          if (scenario === "resize") proc?.terminal?.resize(120, 40);
          // resize 先于退出键：保证 window-change 已被子进程消费。
          exitTimer = setTimeout(() => {
            try {
              proc?.terminal?.write(EXIT_KEY);
            } catch {
              // 已退出
            }
          }, 80);
        },
      },
    });
    const exitCode = await proc.exited;
    return {
      scenario,
      exitCode,
      raw,
      platform: process.platform,
      enteredAlternate: raw.includes(ALTERNATE_ENTER),
      restoredAlternate: raw.includes(ALTERNATE_EXIT),
      rawModeMarkers: raw.includes(BRACKETED_PASTE_ON) && raw.includes(MOUSE_TRACKING_ON),
      resizeSequence: raw.includes("\x1b[8;40;120t"),
      abnormalFixture: raw.includes("ABNORMAL_FIXTURE") || exitCode === 1,
    };
  } finally {
    if (exitTimer !== undefined) clearTimeout(exitTimer);
    clearTimeout(killTimer);
    try {
      proc?.terminal?.close();
    } catch {
      // 已关闭
    }
  }
}

/** 返回失败项列表；空列表表示该场景全部真实校验通过。 */
export function checkPtyResult(result: PtyScenarioResult): string[] {
  const failures: string[] = [];
  const expectedCode = result.scenario === "abnormal" ? 1 : 0;
  if (result.exitCode !== expectedCode) {
    failures.push(`exitCode=${result.exitCode}，期望 ${expectedCode}`);
  }
  if (!result.enteredAlternate) failures.push("未观测到真实备用屏进入序列");
  if (!result.restoredAlternate) failures.push("未观测到真实备用屏退出/复位序列");
  if (!result.rawModeMarkers) failures.push("未观测到 raw 模式启用标记（bracketed paste / mouse tracking）");
  if (result.scenario === "resize" && !result.resizeSequence) failures.push("未观测到 resize window-change 上报");
  if (result.scenario === "abnormal" && !result.abnormalFixture) failures.push("异常夹具未走异常退出路径");
  return failures;
}

export async function runAllPtyScenarios(
  options: PtyScenarioOptions = {},
): Promise<Array<PtyScenarioResult & { readonly failures: string[] }>> {
  const results: Array<PtyScenarioResult & { readonly failures: string[] }> = [];
  for (const scenario of PTY_SCENARIOS) {
    const result = await runPtyScenario(scenario, options);
    results.push({ ...result, failures: checkPtyResult(result) });
  }
  return results;
}
