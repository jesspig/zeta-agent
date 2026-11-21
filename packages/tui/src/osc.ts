export type OscKind = "progress" | "status";

const OSC_7501 = "7501";
const OSC_9_4 = "9;4";

/** 构造 OSC 控制序列（7501 进度、9;4 工作状态），不直接依赖 native。 */
export function oscSequence(kind: OscKind, value: string | number): string {
  if (kind === "progress") {
    return `\x1b]${OSC_7501};${String(value)}\x1b\\`;
  }
  const state = value === "working" || value === "busy" ? 1 : 0;
  return `\x1b]${OSC_9_4};${state}\x1b\\`;
}

export interface OscReporter {
  reportProgress(percent: number): void;
  reportStatus(status: string): void;
}

/** OSC 上报封装：写入函数可注入以便 spy，native 不可用时传入 no-op。 */
export function createOscReporter(write: (sequence: string) => void): OscReporter {
  return {
    reportProgress(percent) {
      write(oscSequence("progress", Math.max(0, Math.min(100, percent))));
    },
    reportStatus(status) {
      write(oscSequence("status", status));
    },
  };
}
