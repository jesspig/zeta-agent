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

import type { AgentSignals } from "./signal";

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

/** 把 agent 状态桥接到 OSC：status 变化时上报工作状态，消息增长时上报粗略进度。返回解除订阅函数。 */
export function createOscBridge(signals: AgentSignals, write: (sequence: string) => void): () => void {
  const reporter = createOscReporter(write);
  const offStatus = signals.status.subscribe((status) => {
    reporter.reportStatus(status === "idle" ? "done" : "working");
  });
  const offMessages = signals.messages.subscribe((messages) => {
    reporter.reportProgress(Math.min(100, messages.length * 2));
  });
  return () => {
    offStatus();
    offMessages();
    reporter.reportStatus("done");
  };
}
