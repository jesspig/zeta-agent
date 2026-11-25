/**
 * T-27 A30：核对 remote 是否具备 wire-level gRPC（proto + server/client 桩 + 依赖）。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function verifyGrpcWire(root = ROOT) {
  const manifestPath = join(root, "packages/deploy/package.json");
  const manifest = existsSync(manifestPath) ? readJson(manifestPath) : {};
  const deps = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };
  const grpcDeps = Object.keys(deps).filter((name) => /^@grpc\/|grpc-js|nice-grpc/.test(name));
  const source = readFileSync(join(root, "packages/deploy/src/grpc.ts"), "utf8");
  const protoPath = join(root, "packages/deploy/proto/zeta.proto");
  const usesGrpcLibrary = /from\s+["'](?:@grpc\/|nice-grpc|grpc)/.test(source);
  const hasProto = existsSync(protoPath) && readFileSync(protoPath, "utf8").includes("service ZetaControl");
  const hasServerClient = source.includes("createGrpcRemoteServer") && source.includes("createGrpcRemoteClient");
  const ok = grpcDeps.length > 0 && usesGrpcLibrary && hasProto && hasServerClient;
  return {
    ok,
    detail: ok
      ? `检测到 wire-level gRPC：依赖 ${grpcDeps.join(", ")}，proto 服务与 server/client 桩齐备`
      : `gRPC wire 证据不足：deps=${grpcDeps.join(",") || "无"} proto=${hasProto} server/client=${hasServerClient}`,
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

if (import.meta.main) {
  const result = verifyGrpcWire();
  console.log(`${result.ok ? "PASS" : "FAIL"} grpc-wire: ${result.detail}`);
  process.exit(result.ok ? 0 : 1);
}
