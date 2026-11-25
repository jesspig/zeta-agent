import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { RPC_ERROR_CODES } from "./rpc";

const GRPC_WIRE_STATUS = Object.freeze({
  OK: 0,
  UNKNOWN: 2,
  INTERNAL: 13,
  UNAUTHENTICATED: 16,
});

const PROTO_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "proto", "zeta.proto");
const PACKAGE_NAME = "zeta.control.v1.ZetaControl";

interface ProtoService {
  service: grpc.ServiceDefinition;
}

function loadService(): ProtoService {
  const definition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const loaded = grpc.loadPackageDefinition(definition) as Record<string, unknown>;
  const namespaces = PACKAGE_NAME.split(".");
  let current: Record<string, unknown> = loaded;
  for (const name of namespaces.slice(0, -1)) {
    current = current[name] as Record<string, unknown>;
  }
  return current[namespaces[namespaces.length - 1]!] as ProtoService;
}

export interface GrpcInvokeRequest {
  readonly token: string;
  readonly generation?: number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

export interface GrpcInvokeResult {
  readonly status: number;
  readonly response?: Record<string, unknown>;
  readonly error?: string;
}

export type GrpcInvokeHandler = (request: GrpcInvokeRequest) => GrpcInvokeResult | Promise<GrpcInvokeResult>;

export interface GrpcServerHandle {
  readonly address: string;
  readonly digest: string;
  close(): Promise<void>;
}

/** 真实 wire-level gRPC server：接收 InvokeRequest，返回 unary 状态与 JSON 响应。 */
export async function createGrpcRemoteServer(
  handler: GrpcInvokeHandler,
  token: string
): Promise<GrpcServerHandle> {
  const service = loadService();
  const server = new grpc.Server();
  const protoDigest = createHash("sha256").update(readFileSync(PROTO_PATH)).digest("hex");
  server.addService(service.service, {
    Invoke: (
      call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>,
      callback: grpc.sendUnaryData<Record<string, unknown>>
    ) => {
      const params = call.request.params_json;
      void (async () => {
        try {
          if (call.request.token !== token) {
            callback({
              code: GRPC_WIRE_STATUS.UNAUTHENTICATED,
              details: "GRPC_UNAUTHENTICATED",
            }, undefined as never);
            return;
          }
          const raw = typeof params === "string"
            ? params
            : Buffer.from((params as Uint8Array | undefined) ?? new Uint8Array()).toString("utf8");
          const decoded = raw.length === 0 ? {} : JSON.parse(raw) as Record<string, unknown>;
          const result = await handler({
            token,
            ...(typeof call.request.generation === "number" ? { generation: call.request.generation } : {}),
            method: String(call.request.method ?? ""),
            params: decoded,
          });
          callback(null, {
            status: result.status,
            response_json: Buffer.from(JSON.stringify(result.response ?? {})),
            ...(result.error === undefined ? {} : { error: result.error }),
          });
        } catch (error) {
          callback({
            code: GRPC_WIRE_STATUS.INTERNAL,
            details: error instanceof Error ? error.message : String(error),
          }, undefined as never);
        }
      })();
    },
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error, bound) => {
      if (error !== null) reject(error);
      else resolve(bound);
    });
  });
  server.start();
  return {
    address: `127.0.0.1:${port}`,
    digest: protoDigest,
    close: () => new Promise<void>((resolve) => server.tryShutdown(() => resolve())),
  };
}

export interface GrpcRemoteClient {
  readonly address: string;
  readonly protoDigest: string;
  invoke(method: string, params?: Record<string, unknown>): Promise<GrpcInvokeResult>;
  close(): void;
}

/** 真实 wire-level gRPC SDK：通过 proto 生成的桩调用远程控制面。 */
export function createGrpcRemoteClient(
  address: string,
  options: { token: string; generation?: number }
): GrpcRemoteClient {
  const service = loadService();
  const protoDigest = createHash("sha256").update(readFileSync(PROTO_PATH)).digest("hex");
  const Client = grpc.makeGenericClientConstructor(service.service, PACKAGE_NAME, {});
  const client = new Client(address, grpc.credentials.createInsecure()) as unknown as grpc.Client & {
    Invoke: (
      request: Record<string, unknown>,
      callback: (error: grpc.ServiceError | null, response: Record<string, unknown>) => void
    ) => void;
  };
  return {
    address,
    protoDigest,
    invoke(method, params) {
      return new Promise<GrpcInvokeResult>((resolve, reject) => {
        client.Invoke(
          {
            token: options.token,
            generation: options.generation ?? 0,
            method,
            params_json: Buffer.from(JSON.stringify(params ?? {})),
          },
          (error, response) => {
            if (error !== null) {
              resolve({ status: error.code ?? GRPC_WIRE_STATUS.UNKNOWN, error: error.details });
              return;
            }
            const raw = response.response_json;
            const text = typeof raw === "string"
              ? raw
              : Buffer.from((raw as Uint8Array | undefined) ?? new Uint8Array()).toString("utf8");
            resolve({
              status: typeof response.status === "number" ? response.status : GRPC_WIRE_STATUS.UNKNOWN,
              ...(text.length === 0 ? {} : { response: JSON.parse(text) as Record<string, unknown> }),
              ...(typeof response.error === "string" && response.error.length > 0 ? { error: response.error } : {}),
            });
          }
        );
      });
    },
    close: () => client.close(),
  };
}

export const GRPC_PROTO_ERROR_CODE = RPC_ERROR_CODES.INVALID_REQUEST;
