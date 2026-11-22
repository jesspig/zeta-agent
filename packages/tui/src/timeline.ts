import type { AgentEvent, AgentMessage } from "@zeta-agent/agent";

/**
 * 对话时间线：把 AgentEvent 归约成按发生顺序排列的条目。
 *
 * 目标终端 UI 的 transcript 是「用户消息 → 助手（思考/正文）→ 工具执行 → …」的单一序列，
 * 因此工具执行必须内联到消息流里，而不是作为独立面板追加在末尾。
 */

export type TimelineStatus = "idle" | "streaming" | "tool";

export interface TimelineUserEntry {
  readonly kind: "user";
  readonly id: string;
  readonly text: string;
}

export interface TimelineAssistantEntry {
  readonly kind: "assistant";
  readonly id: string;
  readonly text: string;
  readonly thinking: string;
  readonly streaming: boolean;
}

export interface TimelineToolEntry {
  readonly kind: "tool";
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
  readonly status: "running" | "done" | "error";
  readonly result?: unknown;
  readonly partialResult?: unknown;
  readonly durationMs?: number;
}

export interface TimelineNoticeEntry {
  readonly kind: "notice";
  readonly id: string;
  readonly tone: "muted" | "warning" | "error" | "success";
  readonly text: string;
}

export type TimelineEntry =
  | TimelineUserEntry
  | TimelineAssistantEntry
  | TimelineToolEntry
  | TimelineNoticeEntry;

export interface TimelineState {
  readonly entries: readonly TimelineEntry[];
  readonly status: TimelineStatus;
  /** 当前流式助手条目的 id；无流式输出时为 undefined。 */
  readonly streamingId?: string;
  readonly seq: number;
}

export function createTimelineState(initialMessages: readonly AgentMessage[] = []): TimelineState {
  return {
    entries: initialTimelineEntries(initialMessages),
    status: "idle",
    seq: initialMessages.length,
  };
}

/** 从历史消息恢复时间线（无工具元数据时降级为提示行）。 */
export function initialTimelineEntries(messages: readonly AgentMessage[]): readonly TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  let seq = 0;
  for (const message of messages) {
    if (message.role === "user") {
      entries.push({ kind: "user", id: `e${++seq}`, text: messageText(message) });
    } else if (message.role === "assistant") {
      entries.push({
        kind: "assistant",
        id: `e${++seq}`,
        text: messageText(message),
        thinking: thinkingText(message),
        streaming: false,
      });
    } else if (message.role === "toolResult") {
      const text = messageText(message);
      if (text.length > 0) {
        entries.push({ kind: "notice", id: `e${++seq}`, tone: "muted", text });
      }
    }
  }
  return entries;
}

export function messageText(message: AgentMessage | { readonly content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  if (typeof content === "object") {
    if (Array.isArray(content)) {
      return content
        .map((block) => {
          if (typeof block === "string") return block;
          if (typeof block === "object" && block !== null) {
            const entry = block as { readonly type?: unknown; readonly text?: unknown };
            if (entry.type === "thinking" || entry.type === "reasoning") return "";
            if (typeof entry.text === "string") return entry.text;
          }
          return "";
        })
        .join("");
    }
    const record = content as { readonly type?: unknown; readonly text?: unknown; readonly content?: unknown };
    if (typeof record.text === "string") return record.text;
    if (typeof record.content === "string") return record.content;
    if (Array.isArray(record.content)) {
      return record.content
        .map((block) => {
          if (typeof block === "string") return block;
          if (typeof block === "object" && block !== null) {
            const entry = block as { readonly type?: unknown; readonly text?: unknown };
            if (entry.type === "thinking" || entry.type === "reasoning") return "";
            if (typeof entry.text === "string") return entry.text;
          }
          return "";
        })
        .join("");
    }
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  return String(content);
}

/** 思考内容：优先读 message.thinking 扩展字段，其次读 thinking 内容块。 */
export function thinkingText(message: AgentMessage | { readonly thinking?: unknown; readonly content?: unknown }): string {
  const extended = message as { readonly thinking?: unknown };
  if (typeof extended.thinking === "string" && extended.thinking.length > 0) return extended.thinking;
  const content = message.content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block !== "object" || block === null) return "";
        const record = block as { readonly type?: unknown; readonly thinking?: unknown; readonly text?: unknown };
        if (record.type !== "thinking" && record.type !== "reasoning") return "";
        if (typeof record.thinking === "string") return record.thinking;
        return typeof record.text === "string" ? record.text : "";
      })
      .filter((part) => part.length > 0)
      .join("\n\n");
  }
  if (typeof content === "object" && content !== null) {
    const record = content as { readonly type?: unknown; readonly thinking?: unknown; readonly text?: unknown };
    if (record.type === "thinking" && typeof record.text === "string") return record.text;
    if (typeof record.thinking === "string") return record.thinking;
  }
  return "";
}

function nextId(state: TimelineState): { readonly id: string; readonly seq: number } {
  const seq = state.seq + 1;
  return { id: `e${seq}`, seq };
}

function replaceEntry(
  entries: readonly TimelineEntry[],
  id: string,
  update: (entry: TimelineEntry) => TimelineEntry,
): readonly TimelineEntry[] {
  return entries.map((entry) => (entry.id === id ? update(entry) : entry));
}

/** 纯归约：不产生副作用，可独立测试。 */
export function applyTimelineEvent(state: TimelineState, event: AgentEvent): TimelineState {
  switch (event.type) {
    case "agent_start":
      return { ...state, status: "streaming" };

    case "agent_end": {
      const entries =
        state.entries.length === 0 && event.messages.length > 0
          ? initialTimelineEntries(event.messages)
          : state.entries
              .map((entry) =>
                entry.kind === "assistant" && entry.streaming ? { ...entry, streaming: false } : entry,
              )
              .filter(
                (entry) =>
                  !(
                    entry.kind === "assistant" &&
                    entry.text.trim().length === 0 &&
                    entry.thinking.trim().length === 0
                  ),
              );
      return { ...state, entries, status: "idle", streamingId: undefined };
    }

    case "turn_start":
      return { ...state, status: state.status === "idle" ? "streaming" : state.status };

    case "turn_end":
      return { ...state, status: state.streamingId ? "streaming" : "idle" };

    case "message_start": {
      if (event.message.role === "user") {
        const { id, seq } = nextId(state);
        return {
          ...state,
          seq,
          status: "streaming",
          entries: [...state.entries, { kind: "user", id, text: messageText(event.message) }],
        };
      }
      if (event.message.role === "assistant") {
        const { id, seq } = nextId(state);
        return {
          ...state,
          seq,
          status: "streaming",
          streamingId: id,
          entries: [
            ...state.entries,
            {
              kind: "assistant",
              id,
              text: messageText(event.message),
              thinking: thinkingText(event.message),
              streaming: true,
            },
          ],
        };
      }
      // toolResult 由 tool_execution_* 渲染，避免重复。
      return state;
    }

    case "message_update": {
      if (event.message.role !== "assistant") return state;
      const text = messageText(event.message);
      const thinking = thinkingText(event.message);
      const targetId = state.streamingId;
      if (targetId !== undefined && state.entries.some((entry) => entry.id === targetId)) {
        return {
          ...state,
          status: "streaming",
          entries: replaceEntry(state.entries, targetId, (entry) =>
            entry.kind === "assistant" ? { ...entry, text, thinking, streaming: true } : entry,
          ),
        };
      }
      const { id, seq } = nextId(state);
      return {
        ...state,
        seq,
        status: "streaming",
        streamingId: id,
        entries: [...state.entries, { kind: "assistant", id, text, thinking, streaming: true }],
      };
    }

    case "message_end": {
      if (event.message.role === "user") {
        const text = messageText(event.message);
        const existing = [...state.entries].reverse().find((entry) => entry.kind === "user");
        if (existing?.kind === "user" && existing.text === text) return state;
        const { id, seq } = nextId(state);
        return { ...state, seq, entries: [...state.entries, { kind: "user", id, text }] };
      }
      if (event.message.role === "assistant") {
        const text = messageText(event.message);
        const thinking = thinkingText(event.message);
        const targetId = state.streamingId;
        if (targetId !== undefined && state.entries.some((entry) => entry.id === targetId)) {
          return {
            ...state,
            streamingId: undefined,
            entries: replaceEntry(state.entries, targetId, (entry) =>
              entry.kind === "assistant" ? { ...entry, text, thinking, streaming: false } : entry,
            ),
          };
        }
        const { id, seq } = nextId(state);
        return {
          ...state,
          seq,
          streamingId: undefined,
          entries: [...state.entries, { kind: "assistant", id, text, thinking, streaming: false }],
        };
      }
      return state;
    }

    case "tool_execution_start": {
      const existing = state.entries.find(
        (entry) => entry.kind === "tool" && entry.id === event.toolCallId,
      );
      if (existing !== undefined) {
        return {
          ...state,
          status: "tool",
          entries: replaceEntry(state.entries, event.toolCallId, (entry) =>
            entry.kind === "tool"
              ? { ...entry, name: event.toolName, args: event.args, status: "running" }
              : entry,
          ),
        };
      }
      return {
        ...state,
        status: "tool",
        entries: [
          ...state.entries,
          {
            kind: "tool",
            id: event.toolCallId,
            name: event.toolName,
            args: event.args,
            status: "running",
          },
        ],
      };
    }

    case "tool_execution_update": {
      return {
        ...state,
        entries: replaceEntry(state.entries, event.toolCallId, (entry) =>
          entry.kind === "tool"
            ? {
                ...entry,
                args: entry.args ?? event.args,
                name: entry.name.length > 0 ? entry.name : event.toolName,
                partialResult: event.partialResult,
              }
            : entry,
        ),
      };
    }

    case "tool_execution_end": {
      const hasEntry = state.entries.some((entry) => entry.kind === "tool" && entry.id === event.toolCallId);
      if (!hasEntry) {
        return {
          ...state,
          status: "streaming",
          entries: [
            ...state.entries,
            {
              kind: "tool",
              id: event.toolCallId,
              name: event.toolName,
              args: {},
              status: event.isError ? "error" : "done",
              result: event.result,
              durationMs: event.durationMs,
            },
          ],
        };
      }
      return {
        ...state,
        status: "streaming",
        entries: replaceEntry(state.entries, event.toolCallId, (entry) =>
          entry.kind === "tool"
            ? {
                ...entry,
                name: entry.name.length > 0 ? entry.name : event.toolName,
                status: event.isError ? "error" : "done",
                result: event.result,
                durationMs: event.durationMs,
              }
            : entry,
        ),
      };
    }

    default: {
      const exhaustive: never = event;
      void exhaustive;
      return state;
    }
  }
}
