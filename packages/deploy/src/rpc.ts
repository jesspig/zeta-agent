import {
  createApprovalBroker,
  createStoreSessionControl as createAgentStoreSessionControl,
  encodeControlFrame,
  type AgentMessage,
  type ApprovalChannel,
  type ApprovalRequest,
  type ControlAction,
  type RuntimeProtocol,
  type StoreSessionControlOptions,
} from "@zeta-agent/agent";

/** approve 复用 T-14 四态审批通道；这里只声明最小 seam，不新建审批路径。 */
export type ApprovalSeam = ApprovalChannel;

export interface ProbeSource {
  readiness(): boolean;
  liveness(): boolean;
  configDigest(): string;
}

export interface RpcSessionControl {
  load(sessionId: string): Promise<{ readonly sessionId: string; readonly messages?: readonly unknown[] }>;
  fork(fromId?: string): Promise<{ readonly sessionId: string; readonly from?: string | null }>;
  resume(frameId: string): Promise<{ readonly sessionId: string; readonly frameId: string }>;
  compact(sessionId: string): Promise<{ readonly sessionId: string; readonly compacted: boolean }>;
}

/**
 * 真实 SessionStore 适配器：生产 daemon / CLI / remote 注入它替换内存 stub。
 * load/fork/resume/compact 的返回值全部来自 committed frame 与 workspace 记录。
 */
export function createStoreSessionControl(options: StoreSessionControlOptions): RpcSessionControl {
  return createAgentStoreSessionControl(options);
}

/** 仅供 RPC 协议/传输夹具使用的内存 seam；生产路径禁止把它当作真实会话能力。 */
export function createMemorySessionControl(): RpcSessionControl {
  return {
    async load(sessionId) {
      return { sessionId, messages: [] };
    },
    async fork(fromId) {
      return { sessionId: `fork:${fromId ?? "head"}`, from: fromId ?? null };
    },
    async resume(frameId) {
      return { sessionId: "resumed", frameId };
    },
    async compact(sessionId) {
      return { sessionId, compacted: true };
    },
  };
}

export interface RpcRuntime {
  readonly protocol: RuntimeProtocol;
  readonly probes: ProbeSource;
  readonly session?: RpcSessionControl;
  readonly approval?: ApprovalSeam;
  /** 宿主扩展方法（如 remote backend 执行）；与内建方法走同一 dispatch 与错误契约。 */
  readonly methods?: Readonly<Record<string, (params: Readonly<Record<string, unknown>>) => Promise<unknown> | unknown>>;
}

export interface RpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface RpcError {
  readonly code: number;
  readonly message: string;
}

export interface RpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly result?: unknown;
  readonly error?: RpcError;
}

export type RpcMethod =
  | "prompt"
  | "continue"
  | "steer"
  | "followUp"
  | "cancel"
  | "approve"
  | "control"
  | "session.load"
  | "session.fork"
  | "session.resume"
  | "session.compact"
  | "readiness"
  | "liveness"
  | "configDigest"
  | "health";

export const RPC_METHODS: readonly RpcMethod[] = Object.freeze([
  "prompt",
  "continue",
  "steer",
  "followUp",
  "cancel",
  "approve",
  "control",
  "session.load",
  "session.fork",
  "session.resume",
  "session.compact",
  "readiness",
  "liveness",
  "configDigest",
  "health",
]);

export const RPC_ERROR_CODES = Object.freeze({
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  RUN_FAILED: -32000,
  NOT_LEADER: -32003,
  STALE_GENERATION: -32005,
  SESSION_UNAVAILABLE: -32004,
});

export interface RpcDispatcher {
  readonly methods: readonly string[];
  handle(request: RpcRequest): Promise<RpcResponse>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(id: number, code: number, message: string): RpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function success(id: number, result: unknown): RpcResponse {
  return { jsonrpc: "2.0", id, result };
}

let approvalSeq = 0;

/**
 * T-10 control 协议 + T-14 审批通道 + 探针的 JSON-RPC 投影。
 * 所有方法都经同一 dispatcher，daemon / remote / headless 共用。
 */
export function createRpcDispatcher(runtime: RpcRuntime): RpcDispatcher {
  const broker = createApprovalBroker(runtime.approval);

  async function dispatchControl(id: number, action: ControlAction, message?: AgentMessage, text?: string): Promise<RpcResponse> {
    try {
      const result = await runtime.protocol.dispatch(
        encodeControlFrame({ action, ...(text === undefined ? {} : { text }), ...(message === undefined ? {} : { message }) })
      );
      if (!result.ok) return failure(id, RPC_ERROR_CODES.RUN_FAILED, result.error ?? "RUN_FAILED");
      return success(id, { ok: true, action, messages: result.messages ?? [] });
    } catch (error) {
      return failure(id, RPC_ERROR_CODES.RUN_FAILED, error instanceof Error ? error.message : String(error));
    }
  }

  async function dispatchSession(id: number, method: string, params: Readonly<Record<string, unknown>>): Promise<RpcResponse> {
    const session = runtime.session;
    if (session === undefined) return failure(id, RPC_ERROR_CODES.SESSION_UNAVAILABLE, "SESSION_UNAVAILABLE");
    try {
      switch (method) {
        case "session.load": {
          if (typeof params.sessionId !== "string") return failure(id, RPC_ERROR_CODES.INVALID_PARAMS, "SESSION_ID_REQUIRED");
          return success(id, await session.load(params.sessionId));
        }
        case "session.fork": {
          const from = params.fromId ?? params.frameId;
          if (from !== undefined && typeof from !== "string") {
            return failure(id, RPC_ERROR_CODES.INVALID_PARAMS, "FORK_ID_INVALID");
          }
          return success(id, await session.fork(from));
        }
        case "session.resume": {
          if (typeof params.frameId !== "string") return failure(id, RPC_ERROR_CODES.INVALID_PARAMS, "FRAME_ID_REQUIRED");
          return success(id, await session.resume(params.frameId));
        }
        case "session.compact": {
          if (typeof params.sessionId !== "string") return failure(id, RPC_ERROR_CODES.INVALID_PARAMS, "SESSION_ID_REQUIRED");
          return success(id, await session.compact(params.sessionId));
        }
        default:
          return failure(id, RPC_ERROR_CODES.METHOD_NOT_FOUND, "METHOD_NOT_FOUND");
      }
    } catch (error) {
      return failure(id, RPC_ERROR_CODES.RUN_FAILED, error instanceof Error ? error.message : String(error));
    }
  }

  return {
    methods: [...RPC_METHODS],
    async handle(request) {
      const id = request?.id;
      if (!isRecord(request as unknown) || request?.jsonrpc !== "2.0" || !Number.isInteger(id) || typeof request?.method !== "string") {
        return failure(typeof id === "number" ? id : 0, RPC_ERROR_CODES.INVALID_REQUEST, "INVALID_REQUEST");
      }
      const method = request.method;
      const params = isRecord(request.params) ? request.params : {};
      const custom = runtime.methods?.[method];
      const known = (RPC_METHODS as readonly string[]).includes(method) || typeof custom === "function";
      if (!known) {
        return failure(id, RPC_ERROR_CODES.METHOD_NOT_FOUND, "METHOD_NOT_FOUND");
      }
      if (custom !== undefined && typeof custom === "function") {
        try {
          return success(id, await custom(params));
        } catch (error) {
          return failure(id, RPC_ERROR_CODES.RUN_FAILED, error instanceof Error ? error.message : String(error));
        }
      }

      switch (method) {
        case "prompt": {
          if (typeof params.text !== "string") return failure(id, RPC_ERROR_CODES.INVALID_PARAMS, "CONTROL_TEXT_REQUIRED");
          return dispatchControl(id, "prompt", undefined, params.text);
        }
        case "continue":
          return dispatchControl(id, "continue");
        case "steer":
        case "followUp": {
          if (!isRecord(params.message)) return failure(id, RPC_ERROR_CODES.INVALID_PARAMS, "CONTROL_MESSAGE_REQUIRED");
          return dispatchControl(id, method, params.message as unknown as AgentMessage);
        }
        case "cancel":
          return dispatchControl(id, "abort");
        case "control": {
          if (typeof params.action !== "string" || !(RPC_CONTROL_ACTIONS as readonly string[]).includes(params.action)) {
            return failure(id, RPC_ERROR_CODES.INVALID_PARAMS, "CONTROL_ACTION_INVALID");
          }
          return dispatchControl(
            id,
            params.action as ControlAction,
            isRecord(params.message) ? (params.message as unknown as AgentMessage) : undefined,
            typeof params.text === "string" ? params.text : undefined
          );
        }
        case "approve": {
          if (typeof params.tool !== "string" || params.tool.length === 0) {
            return failure(id, RPC_ERROR_CODES.INVALID_PARAMS, "APPROVAL_TOOL_REQUIRED");
          }
          const requestId = typeof params.requestId === "string" && params.requestId.length > 0
            ? params.requestId
            : `rpc-approval-${(approvalSeq += 1)}`;
          const approval: ApprovalRequest = {
            requestId,
            stage: typeof params.stage === "string" ? params.stage : "plan",
            tool: params.tool,
            args: isRecord(params.args) ? params.args : {},
            ...(typeof params.reason === "string" ? { reason: params.reason } : {}),
          };
          const decision = await broker.request(approval);
          return success(id, {
            state: decision.state,
            allowed: decision.allowed,
            requestId: decision.requestId,
            ...(decision.replyId === undefined ? {} : { replyId: decision.replyId }),
            ...(decision.reason === undefined ? {} : { reason: decision.reason }),
          });
        }
        case "session.load":
        case "session.fork":
        case "session.resume":
        case "session.compact":
          return dispatchSession(id, method, params);
        case "readiness":
          return success(id, runtime.probes.readiness());
        case "liveness":
          return success(id, runtime.probes.liveness());
        case "configDigest":
          return success(id, runtime.probes.configDigest());
        case "health":
          return success(id, {
            ready: runtime.probes.readiness(),
            live: runtime.probes.liveness(),
            digest: runtime.probes.configDigest(),
          });
        default:
          return failure(id, RPC_ERROR_CODES.METHOD_NOT_FOUND, "METHOD_NOT_FOUND");
      }
    },
  };
}

const RPC_CONTROL_ACTIONS: readonly string[] = Object.freeze([
  "prompt",
  "continue",
  "steer",
  "followUp",
  "abort",
  "reset",
]);

/** JSON-RPC 行编码：stdout 专属 writer 只写这个编码结果。 */
export function encodeRpcResponse(response: RpcResponse): string {
  return JSON.stringify(response);
}

export function decodeRpcRequest(line: string): RpcRequest {
  const parsed: unknown = JSON.parse(line);
  if (!isRecord(parsed)) throw new Error("RPC_INVALID_FRAME");
  return parsed as unknown as RpcRequest;
}
