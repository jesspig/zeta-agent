export interface AgentToolCallRecord {
  readonly id: string;
  readonly name: string;
  /** JSON 字符串形式的参数（与 OpenAI tool_calls.function.arguments 对齐）。 */
  readonly arguments: string;
}

export interface AgentMessage {
  readonly role: "system" | "user" | "assistant" | "toolResult";
  readonly content: unknown;
  /** 助手推理/思考内容（provider 原生 reasoning 或 thinking 块）。 */
  readonly thinking?: string;
  /** 助手消息发起的工具调用，供多轮工具协议回传给模型。 */
  readonly toolCalls?: readonly AgentToolCallRecord[];
  /** toolResult 对应的调用 id。 */
  readonly toolCallId?: string;
  /** toolResult 对应的工具名。 */
  readonly toolName?: string;
}

export interface AssistantMessageEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface ToolResultMessage extends AgentMessage {
  readonly toolCallId?: string;
}

export type AgentEvent =
  | { readonly type: "agent_start" }
  /** messages 仅包含本次 run 新增消息；完整 transcript 始终由 state.messages 持有。 */
  | { readonly type: "agent_end"; readonly messages: readonly AgentMessage[] }
  | { readonly type: "turn_start" }
  | { readonly type: "turn_end"; readonly message: AgentMessage; readonly toolResults: readonly ToolResultMessage[] }
  | { readonly type: "message_start"; readonly message: AgentMessage }
  | { readonly type: "message_update"; readonly message: AgentMessage; readonly assistantMessageEvent: AssistantMessageEvent }
  | { readonly type: "message_end"; readonly message: AgentMessage }
  | { readonly type: "tool_execution_start"; readonly toolCallId: string; readonly toolName: string; readonly args: unknown }
  | { readonly type: "tool_execution_update"; readonly toolCallId: string; readonly toolName: string; readonly args: unknown; readonly partialResult: unknown }
  | { readonly type: "tool_execution_end"; readonly toolCallId: string; readonly toolName: string; readonly result: unknown; readonly isError: boolean; readonly durationMs?: number };

export const AGENT_EVENT_TYPES = [
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
] as const satisfies readonly AgentEvent["type"][];

export interface AgentState {
  readonly systemPrompt: string;
  readonly isStreaming: boolean;
  readonly streamingMessage?: AgentMessage;
  readonly pendingToolCalls: ReadonlySet<string>;
  readonly messages: readonly AgentMessage[];
  readonly errorMessage?: string;
}

export function createInitialState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    systemPrompt: "",
    isStreaming: false,
    pendingToolCalls: new Set<string>(),
    messages: [],
    ...overrides,
  };
}

export function reduceState(state: AgentState, event: AgentEvent): AgentState {
  switch (event.type) {
    case "agent_start":
      return { ...state, isStreaming: false, streamingMessage: undefined, pendingToolCalls: new Set<string>(), errorMessage: undefined };
    case "agent_end":
      // 运行已终止：清空本运行的待处理工具；newMessages 不替换已归约的 transcript。
      return { ...state, isStreaming: false, streamingMessage: undefined, pendingToolCalls: new Set<string>() };
    case "turn_start":
      return { ...state, isStreaming: false, streamingMessage: undefined };
    case "turn_end":
      return { ...state, isStreaming: false, streamingMessage: undefined };
    case "message_start":
      return { ...state, isStreaming: true, streamingMessage: event.message };
    case "message_update":
      return { ...state, isStreaming: true, streamingMessage: event.message };
    case "message_end":
      return { ...state, isStreaming: false, streamingMessage: undefined, messages: [...state.messages, event.message] };
    case "tool_execution_start": {
      const pendingToolCalls = new Set(state.pendingToolCalls);
      pendingToolCalls.add(event.toolCallId);
      return { ...state, pendingToolCalls };
    }
    case "tool_execution_update":
      return state;
    case "tool_execution_end": {
      const pendingToolCalls = new Set(state.pendingToolCalls);
      pendingToolCalls.delete(event.toolCallId);
      return { ...state, pendingToolCalls, errorMessage: event.isError ? String(event.result) : state.errorMessage };
    }
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

export type AgentListener = (event: AgentEvent, signal?: AbortSignal) => void | Promise<void>;

export interface EventStream {
  getState(): AgentState;
  subscribe(listener: AgentListener): () => void;
  emit(event: AgentEvent, signal?: AbortSignal): Promise<void>;
  waitForIdle(): Promise<void>;
  /** 清空状态与在途等待，保留订阅者，供新建会话使用。 */
  reset(): void;
  readonly listenerCount: number;
}

export function createEventStream(initial: AgentState = createInitialState()): EventStream {
  let state = initial;
  let listeners: AgentListener[] = [];
  const inFlight = new Set<Promise<void>>();
  const idleWaiters: Array<() => void> = [];

  function flushIdle(): void {
    if (inFlight.size !== 0) return;
    for (const resolve of idleWaiters.splice(0)) resolve();
  }

  async function dispatch(event: AgentEvent, signal?: AbortSignal): Promise<void> {
    for (const listener of [...listeners]) await listener(event, signal);
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.push(listener);
      return () => {
        listeners = listeners.filter((item) => item !== listener);
      };
    },
    emit(event, signal) {
      state = reduceState(state, event);
      const pending = dispatch(event, signal);
      inFlight.add(pending);
      void pending.then(
        () => {
          inFlight.delete(pending);
          flushIdle();
        },
        () => {
          inFlight.delete(pending);
          flushIdle();
        }
      );
      return pending;
    },
    waitForIdle() {
      if (inFlight.size === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
      });
    },
    reset() {
      state = createInitialState();
      inFlight.clear();
      for (const resolve of idleWaiters.splice(0)) resolve();
    },
    get listenerCount() {
      return listeners.length;
    },
  };
}
