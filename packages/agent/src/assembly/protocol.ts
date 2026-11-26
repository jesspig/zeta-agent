import {
  classifyRecap,
  createMemoryWorkspaceStore,
  createOffloader,
  type Offloader,
  type WorkspaceStore,
} from "@zeta-agent/agent-framework";
import type { Agent, AgentMessage } from "../facade";
import type { SessionStore } from "../session/store";

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

/** 真实会话控制结果：全部字段来自 SessionStore 的 committed frame，不是固定返回值。 */
export interface RuntimeSessionLoadResult {
  readonly sessionId: string;
  readonly messages: readonly AgentMessage[];
  readonly leafId: string | null;
  readonly lineageCount: number;
}
export interface RuntimeSessionForkResult {
  readonly sessionId: string;
  readonly from: string | null;
  readonly frameId: string | null;
}
export interface RuntimeSessionResumeResult {
  readonly sessionId: string;
  readonly frameId: string;
}
export interface RuntimeSessionCompactResult {
  readonly sessionId: string;
  readonly compacted: boolean;
  readonly uris: readonly string[];
  readonly frameId: string | null;
}

export interface RuntimeSessionControl {
  load(sessionId?: string): Promise<RuntimeSessionLoadResult>;
  fork(fromId?: string): Promise<RuntimeSessionForkResult>;
  resume(frameId: string): Promise<RuntimeSessionResumeResult>;
  compact(sessionId?: string): Promise<RuntimeSessionCompactResult>;
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
  /** 注入真实 SessionStore 后可用；未注入时不提供该能力，绝不返回内存 stub。 */
  readonly sessionControl?: RuntimeSessionControl;
  dispatch(frame: ControlFrame): Promise<ControlResult>;
}

export interface StoreSessionControlOptions {
  readonly store: SessionStore;
  /** 绑定 agent 时，load/fork/resume/compact 成功后重新回放 committed transcript。 */
  readonly agent?: Agent;
  /** 按 sessionId 打开已有 store；fork/resume 产生的新视图注册到同一注册表。 */
  readonly open?: (sessionId: string) => SessionStore;
  readonly offloader?: Offloader;
  readonly workspaceStore?: WorkspaceStore;
  readonly maxOutputBytes?: number;
}

/**
 * 真实 SessionStore 适配器：load 读 committed projection，fork/resume 调 store 的 marker/view，
 * compact 把 typed recap 与 workspace URI 作为真实 frame 追加。所有返回值来自存储状态。
 */
export function createStoreSessionControl(options: StoreSessionControlOptions): RuntimeSessionControl {
  const stores = new Map<string, SessionStore>([[options.store.sessionId, options.store]]);
  const offloader = options.offloader ?? createOffloader(
    options.workspaceStore ?? createMemoryWorkspaceStore(),
    options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }
  );

  const resolveStore = (sessionId?: string): SessionStore => {
    if (sessionId === undefined) return options.store;
    const existing = stores.get(sessionId);
    if (existing !== undefined) return existing;
    if (options.open === undefined) throw new Error("SESSION_NOT_FOUND");
    const opened = options.open(sessionId);
    stores.set(sessionId, opened);
    return opened;
  };

  const rebind = (store: SessionStore): void => {
    options.agent?.attachSessionStore(store);
  };

  return {
    async load(sessionId) {
      const store = resolveStore(sessionId);
      const projection = store.projection();
      rebind(store);
      return {
        sessionId: sessionId ?? store.sessionId,
        messages: projection.messages,
        leafId: projection.leafId,
        lineageCount: projection.lineage.length,
      };
    },
    async fork(fromId) {
      const forked = await options.store.fork(fromId);
      const frameId = forked.projection().leafId;
      const sessionId = `fork:${fromId ?? "head"}:${frameId ?? forked.sessionId}`;
      stores.set(sessionId, forked);
      rebind(forked);
      return { sessionId, from: fromId ?? null, frameId };
    },
    async resume(frameId) {
      const resumed = options.store.resume(frameId);
      const sessionId = `resume:${frameId}`;
      stores.set(sessionId, resumed);
      rebind(resumed);
      return { sessionId, frameId };
    },
    async compact(sessionId) {
      const store = resolveStore(sessionId);
      const projection = store.projection();
      const block = projection.branch.map((frame) => frame.kind === "message" ? { kind: "message" as const, message: frame.message } : null)
        .filter((entry): entry is { kind: "message"; message: AgentMessage } => entry !== null);
      const prompt = options.agent?.state.systemPrompt ?? "";
      const recapBlock: readonly { readonly kind: "message"; readonly message: AgentMessage }[] = prompt.length > 0
        ? [{ kind: "message", message: { role: "system", content: prompt } }, ...block]
        : block;
      const uris = await offloader.offload(recapBlock, "rpc-compaction");
      const receipt = await store.appendRecap(
        classifyRecap(recapBlock, [uris]),
        [uris],
        { threshold: 1, preTokenCount: recapBlock.length }
      );
      rebind(store);
      return { sessionId: sessionId ?? store.sessionId, compacted: true, uris: [uris], frameId: receipt.frameId };
    },
  };
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
export function createRuntimeProtocol(
  agent: Agent,
  sessionId = "zeta-session",
  sessionControl?: RuntimeSessionControl
): RuntimeProtocol {
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
    ...(sessionControl === undefined ? {} : { sessionControl }),
    dispatch,
  };
}
