import {
  createCredentialBroker,
  createEgressGateway,
  createEgressPolicy,
  withCredentialFetch,
  type Capabilities,
  type Command,
  type CredentialBinding,
  type CredentialBoundaryRef,
  type DnsGate,
  type EgressEnforcer,
  type EgressGateway,
  type EgressPolicyOptions,
  type ExecutionBackend,
  type RunOptions,
  type RunResult,
} from "@zeta-agent/components";
import { RPC_ERROR_CODES, type RpcRequest, type RpcResponse } from "./rpc";

/** gRPC 风格 unary 状态码：远端调用无本地 gRPC 运行时依赖，但沿用同一状态语义。 */
export const GRPC_STATUS = Object.freeze({
  OK: 0,
  CANCELLED: 1,
  UNKNOWN: 2,
  INVALID_ARGUMENT: 3,
  NOT_FOUND: 5,
  PERMISSION_DENIED: 7,
  UNAVAILABLE: 14,
  INTERNAL: 13,
  UNAUTHENTICATED: 16,
});

export function toGrpcStatus(response: RpcResponse): number {
  if (response.error === undefined) return GRPC_STATUS.OK;
  switch (response.error.code) {
    case RPC_ERROR_CODES.INVALID_REQUEST:
    case RPC_ERROR_CODES.INVALID_PARAMS:
      return GRPC_STATUS.INVALID_ARGUMENT;
    case RPC_ERROR_CODES.METHOD_NOT_FOUND:
      return GRPC_STATUS.NOT_FOUND;
    case RPC_ERROR_CODES.NOT_LEADER:
    case RPC_ERROR_CODES.STALE_GENERATION:
      return GRPC_STATUS.PERMISSION_DENIED;
    case -32001:
      return GRPC_STATUS.UNAUTHENTICATED;
    default:
      return GRPC_STATUS.INTERNAL;
  }
}

export class RemoteRpcError extends Error {
  readonly code: number;
  readonly status: number;

  constructor(message: string, code: number, status: number) {
    super(message);
    this.name = "RemoteRpcError";
    this.code = code;
    this.status = status;
  }
}

export interface RemoteClientOptions {
  readonly url: string;
  readonly token: string;
  /** 客户端代次；与 daemon 代次不符时请求被栅栏拒绝。 */
  readonly generation?: number;
  readonly fetch?: typeof fetch;
}

export interface RemoteInvokeResult {
  readonly response: RpcResponse;
  readonly status: number;
}

export interface RemoteClient {
  readonly url: string;
  readonly generation: number | undefined;
  call(method: string, params?: Record<string, unknown>): Promise<RpcResponse>;
  /** gRPC 风格：错误作为状态码返回，不抛异常。 */
  invoke(method: string, params?: Record<string, unknown>): Promise<RemoteInvokeResult>;
  prompt(text: string): Promise<RpcResponse>;
  steer(message: unknown): Promise<RpcResponse>;
  followUp(message: unknown): Promise<RpcResponse>;
  cancel(): Promise<RpcResponse>;
  approve(request: Record<string, unknown>): Promise<RpcResponse>;
  load(sessionId: string): Promise<RpcResponse>;
  fork(fromId?: string): Promise<RpcResponse>;
  resume(frameId: string): Promise<RpcResponse>;
  compact(sessionId: string): Promise<RpcResponse>;
  readiness(): Promise<RpcResponse>;
  liveness(): Promise<RpcResponse>;
  configDigest(): Promise<RpcResponse>;
  health(): Promise<RpcResponse>;
}

/** 远端 SDK：所有方法走同一个有 token/代次元数据的 unary 入口。 */
export function createRemoteClient(options: RemoteClientOptions): RemoteClient {
  if (typeof options.url !== "string" || options.url.length === 0) throw new Error("REMOTE_URL_REQUIRED");
  if (typeof options.token !== "string" || options.token.length === 0) throw new Error("REMOTE_TOKEN_REQUIRED");
  const url = options.url.replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  let seq = 0;

  async function invoke(method: string, params?: Record<string, unknown>): Promise<RemoteInvokeResult> {
    const request: RpcRequest = {
      jsonrpc: "2.0",
      id: (seq += 1),
      method,
      ...(params === undefined ? {} : { params }),
    };
    const response = await fetchImpl(`${url}/rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${options.token}`,
        "x-zeta-token": options.token,
        ...(options.generation === undefined ? {} : { "x-zeta-generation": String(options.generation) }),
      },
      body: JSON.stringify(request),
    });
    const payload = (await response.json()) as RpcResponse;
    return { response: payload, status: response.ok ? toGrpcStatus(payload) : GRPC_STATUS.UNAVAILABLE };
  }

  async function call(method: string, params?: Record<string, unknown>): Promise<RpcResponse> {
    const { response, status } = await invoke(method, params);
    if (response.error !== undefined || status !== GRPC_STATUS.OK) {
      throw new RemoteRpcError(
        response.error?.message ?? `REMOTE_HTTP_${status}`,
        response.error?.code ?? -1,
        status
      );
    }
    return response;
  }

  return {
    url,
    generation: options.generation,
    call,
    invoke,
    prompt: (text) => call("prompt", { text }),
    steer: (message) => call("steer", { message }),
    followUp: (message) => call("followUp", { message }),
    cancel: () => call("cancel"),
    approve: (request) => call("approve", request),
    load: (sessionId) => call("session.load", { sessionId }),
    fork: (fromId) => call("session.fork", fromId === undefined ? {} : { fromId }),
    resume: (frameId) => call("session.resume", { frameId }),
    compact: (sessionId) => call("session.compact", { sessionId }),
    readiness: () => call("readiness"),
    liveness: () => call("liveness"),
    configDigest: () => call("configDigest"),
    health: () => call("health"),
  };
}

export interface RemoteBackendOptions {
  readonly client: RemoteClient;
  readonly name?: string;
}

const REMOTE_CAPABILITIES: Capabilities = Object.freeze({
  isolation: "degraded",
  seccomp: "unsupported",
  fsConfinement: "degraded",
  auditSink: "active",
  egressDefaultDeny: "active",
});

/** 远程执行后端：复用 ExecutionBackend 契约，执行经 RPC 转发，不新建权限路径。 */
export function createRemoteBackend(options: RemoteBackendOptions): ExecutionBackend {
  return {
    name: options.name ?? "remote",
    capabilities: () => REMOTE_CAPABILITIES,
    async run(command: Command, runOptions: RunOptions = {}): Promise<RunResult> {
      const reply = await options.client.call("backend.run", {
        argv: [...command.argv],
        ...(runOptions.realm === undefined ? {} : { realm: runOptions.realm }),
      });
      const result = reply.result as Partial<RunResult> | undefined;
      if (typeof result !== "object" || result === null) throw new Error("REMOTE_BACKEND_INVALID_RESULT");
      return {
        exitCode: Number(result.exitCode ?? 1),
        stdout: typeof result.stdout === "string" ? result.stdout : "",
        stderr: typeof result.stderr === "string" ? result.stderr : "",
        isolated: typeof result.isolated === "string" ? result.isolated : null,
      };
    },
    dispose: () => {},
  };
}

export interface RemoteSidecarOptions {
  readonly url: string;
  readonly token: string;
  readonly secret: { readonly name: string; readonly secret: string; readonly binding: CredentialBinding };
  readonly egress: EgressPolicyOptions;
  readonly generation?: number;
  readonly fetch?: typeof fetch;
  readonly dns?: DnsGate;
  readonly enforcers?: readonly EgressEnforcer[];
}

export interface RemoteSidecar {
  readonly credential: CredentialBoundaryRef;
  readonly gateway: EgressGateway;
  readonly client: RemoteClient;
  close(): void;
}

/**
 * 远程 sidecar：凭证只由 T-14 broker 在闭包内持有，出站请求统一过 T-14 egress 网关。
 * 明文不进入 client、产物或日志。
 */
export function createRemoteSidecar(options: RemoteSidecarOptions): RemoteSidecar {
  const broker = createCredentialBroker();
  const handle = broker.issue({
    name: options.secret.name,
    binding: options.secret.binding,
    secret: options.secret.secret,
  });
  const credential: CredentialBoundaryRef = { broker, handle };
  const gateway = createEgressGateway({
    policy: createEgressPolicy(options.egress),
    fetch: options.fetch ?? globalThis.fetch,
    ...(options.dns === undefined ? {} : { dns: options.dns }),
    ...(options.enforcers === undefined ? {} : { enforcers: options.enforcers }),
  });
  const client = createRemoteClient({
    url: options.url,
    token: options.token,
    ...(options.generation === undefined ? {} : { generation: options.generation }),
    fetch: withCredentialFetch(broker, handle, gateway.fetch as typeof fetch),
  });
  return {
    credential,
    gateway,
    client,
    close() {
      broker.invalidateAll();
    },
  };
}
