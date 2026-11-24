import type { Agent, AgentMessage } from "../facade";

/** 四种 CLI 形态共享的控制动作；RPC method 与 TUI 命令都投影到这里。 */
export type ControlAction = "prompt" | "continue" | "steer" | "followUp" | "abort" | "reset";

export interface ControlFrame {
  readonly type: "control";
  readonly action: ControlAction;
  readonly text?: string;
  readonly message?: AgentMessage;
}

export interface ControlResult {
  readonly type: "control.result";
  readonly ok: boolean;
  readonly action: ControlAction;
  readonly messages?: readonly AgentMessage[];
  readonly error?: string;
}

export interface RuntimeEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface RuntimeProtocol {
  readonly session: {
    readonly id: string;
    messages(): readonly AgentMessage[];
    reset(): void;
  };
  readonly control: {
    dispatch(frame: ControlFrame): Promise<ControlResult>;
  };
  readonly event: {
    subscribe(listener: (event: RuntimeEvent) => void): () => void;
  };
  dispatch(frame: ControlFrame): Promise<ControlResult>;
}

export function encodeControlFrame(input: {
  readonly action: ControlAction;
  readonly text?: string;
  readonly message?: AgentMessage;
}): ControlFrame {
  return {
    type: "control",
    action: input.action,
    ...(input.text !== undefined ? { text: input.text } : {}),
    ...(input.message !== undefined ? { message: input.message } : {}),
  };
}

/**
 * 在单个 Agent 之上建立 session/control/event 三视图。
 * interactive、headless、json、rpc 只通过该协议访问运行时，装配与事件语义完全一致。
 */
export function createRuntimeProtocol(agent: Agent, sessionId = "zeta-session"): RuntimeProtocol {
  const dispatch = async (frame: ControlFrame): Promise<ControlResult> => {
    const { action } = frame;
    try {
      switch (action) {
        case "prompt": {
          if (typeof frame.text !== "string") {
            return { type: "control.result", ok: false, action, error: "CONTROL_TEXT_REQUIRED" };
          }
          const messages = await agent.prompt(frame.text);
          await agent.waitForIdle();
          return { type: "control.result", ok: true, action, messages };
        }
        case "continue": {
          const messages = await agent.continue();
          await agent.waitForIdle();
          return { type: "control.result", ok: true, action, messages };
        }
        case "steer": {
          if (frame.message === undefined) {
            return { type: "control.result", ok: false, action, error: "CONTROL_MESSAGE_REQUIRED" };
          }
          agent.steer(frame.message);
          return { type: "control.result", ok: true, action };
        }
        case "followUp": {
          if (frame.message === undefined) {
            return { type: "control.result", ok: false, action, error: "CONTROL_MESSAGE_REQUIRED" };
          }
          agent.followUp(frame.message);
          return { type: "control.result", ok: true, action };
        }
        case "abort":
          agent.abort();
          return { type: "control.result", ok: true, action };
        case "reset":
          agent.reset();
          return { type: "control.result", ok: true, action };
        default:
          return { type: "control.result", ok: false, action, error: "UNKNOWN_CONTROL_ACTION" };
      }
    } catch (error) {
      return {
        type: "control.result",
        ok: false,
        action,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  return {
    session: {
      id: sessionId,
      messages: () => agent.state.messages,
      reset: () => agent.reset(),
    },
    control: { dispatch },
    event: {
      subscribe: (listener) => agent.subscribe((event) => listener(event as RuntimeEvent)) as () => void,
    },
    dispatch,
  };
}
