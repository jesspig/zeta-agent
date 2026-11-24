/**
 * 独立审计 daemon：独占 append-only 日志与 HMAC secret，主进程只能通过本地 socket 追加/封存/校验。
 * 运行方式：ZETA_AUDIT_SIGNING_SECRET=... ZETA_AUDIT_CLIENT_TOKEN=... ZETA_AUDIT_ENDPOINT=tcp:127.0.0.1:0 ZETA_AUDIT_DIR=<dir> bun audit-daemon.ts
 * 端口为 0 时把实际端点写入 <dir>/endpoint，供调用方发现；该值只是地址，不含密钥。
 */
import { createHmac } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AUDIT_CLIENT_TOKEN_ENV,
  AUDIT_SIGNING_SECRET_ENV,
  createFileAuditStorage,
  defaultHash,
  entrySignaturePayload,
  finalSignaturePayload,
  fingerprint,
  recoverAuditChain,
  verifyAuditIntegrity,
  type AuditEntry,
  type AuditRecord,
  type FinalizedState,
} from "./audit";

interface StoredAuditLine {
  readonly entry: AuditEntry;
  readonly signature: string;
}

interface DaemonConfig {
  readonly secret: string;
  readonly token: string;
  readonly endpoint: string;
  readonly dir: string;
}

function readConfig(): DaemonConfig {
  const secret = process.env[AUDIT_SIGNING_SECRET_ENV];
  const token = process.env[AUDIT_CLIENT_TOKEN_ENV];
  const endpoint = process.env.ZETA_AUDIT_ENDPOINT;
  const dir = process.env.ZETA_AUDIT_DIR;
  if (typeof secret !== "string" || secret.length === 0) throw new Error("MISSING_AUDIT_SIGNING_SECRET");
  if (typeof token !== "string" || token.length === 0) throw new Error("MISSING_AUDIT_CLIENT_TOKEN");
  if (typeof endpoint !== "string" || endpoint.length === 0) throw new Error("MISSING_AUDIT_ENDPOINT");
  if (typeof dir !== "string" || dir.length === 0) throw new Error("MISSING_AUDIT_DIR");
  return { secret, token, endpoint, dir };
}

function main(): void {
  const config = readConfig();
  mkdirSync(config.dir, { recursive: true });
  const storage = createFileAuditStorage(config.dir);
  const sign = (payload: string): string => createHmac("sha256", config.secret).update(payload).digest("hex");

  // 重启时先恢复并校验已有链，损坏则拒绝启动，绝不从断点继续追加。
  const restored = recoverAuditChain({ lines: storage.readLines(), hash: defaultHash, sign });
  let seq = restored.seq;
  let previous = restored.head;
  const hashes: string[] = [...restored.hashes];

  function hashOf(entrySeq: number, prevHash: string, record: AuditRecord): string {
    return defaultHash(fingerprint(entrySeq, prevHash, record));
  }

  function handle(request: Record<string, unknown>): Record<string, unknown> {
    if (request.token !== config.token) return { ok: false, error: "UNAUTHORIZED" };
    switch (request.kind) {
      case "ping":
        return { ok: true };
      case "append": {
        const record = request.record as AuditRecord;
        if (typeof record !== "object" || record === null || typeof record.toolName !== "string") {
          return { ok: false, error: "INVALID_RECORD" };
        }
        const entry: AuditEntry = {
          seq,
          prevHash: previous,
          record,
          hash: hashOf(seq, previous, record),
        };
        const stored: StoredAuditLine = { entry, signature: sign(entrySignaturePayload(entry)) };
        storage.append(JSON.stringify(stored));
        seq += 1;
        previous = entry.hash;
        hashes.push(entry.hash);
        return { ok: true, acknowledged: true, seq: entry.seq, prevHash: entry.prevHash, hash: entry.hash, head: entry.hash };
      }
      case "finalize": {
        const revision = Number(request.revision);
        const finalized = request.finalized as FinalizedState;
        if (!Number.isInteger(revision) || revision < 0) return { ok: false, error: "INVALID_REVISION" };
        if (finalized !== "complete" && finalized !== "complete-with-drops" && finalized !== "incomplete") {
          return { ok: false, error: "INVALID_FINALIZED" };
        }
        const digest = defaultHash(hashes.join("|"));
        const marker = {
          schema: "zeta-audit-signed/v1",
          revision,
          finalized,
          seq: hashes.length,
          head: hashes.length > 0 ? hashes[hashes.length - 1]! : "0",
          digest,
          signature: sign(finalSignaturePayload(revision, digest, finalized, hashes.length)),
        };
        storage.writeMarker(revision, JSON.stringify(marker));
        return { ok: true, revision, seq: hashes.length };
      }
      case "verify": {
        const revision = Number(request.revision);
        if (!Number.isInteger(revision) || revision < 0) return { ok: false, error: "INVALID_REVISION" };
        // 校验失败是业务结果而非传输错误：始终 ok:true，结果放在 result 里。
        return { ok: true, result: verifyAuditIntegrity({ storage, hash: defaultHash, sign, revision }) };
      }
      default:
        return { ok: false, error: "UNKNOWN_KIND" };
    }
  }

  const buffers = new Map<unknown, string>();
  const decoders = new Map<unknown, TextDecoder>();
  const socketHandler = {
    data(socket: unknown, data: Uint8Array) {
      let decoder = decoders.get(socket);
      if (decoder === undefined) {
        decoder = new TextDecoder();
        decoders.set(socket, decoder);
      }
      const current = (buffers.get(socket) ?? "") + decoder.decode(data, { stream: true });
      let rest = current;
      let index = rest.indexOf("\n");
      const writer = socket as { write(data: string): number };
      while (index >= 0) {
        const line = rest.slice(0, index);
        rest = rest.slice(index + 1);
        index = rest.indexOf("\n");
        if (line.length === 0) continue;
        let request: Record<string, unknown>;
        try {
          request = JSON.parse(line) as Record<string, unknown>;
        } catch {
          writer.write(`${JSON.stringify({ ok: false, error: "INVALID_REQUEST" })}\n`);
          continue;
        }
        const reply = { ...handle(request), ...(request.id === undefined ? {} : { id: request.id }) };
        writer.write(`${JSON.stringify(reply)}\n`);
      }
      buffers.set(socket, rest);
    },
    close(socket: unknown) {
      buffers.delete(socket);
      decoders.delete(socket);
    },
  };

  if (config.endpoint.startsWith("tcp:")) {
    const match = /^tcp:([^:]+):(\d+)$/.exec(config.endpoint);
    if (match === null) throw new Error("INVALID_AUDIT_ENDPOINT");
    const hostname = match[1]!;
    const server = Bun.listen({ hostname, port: Number(match[2]), socket: socketHandler });
    const resolved = server.port > 0 ? `tcp:${hostname}:${server.port}` : config.endpoint;
    writeFileSync(join(config.dir, "endpoint"), `${resolved}\n`, "utf8");
    void server;
    return;
  }

  const path = config.endpoint.startsWith("unix:") ? config.endpoint.slice(5) : config.endpoint;
  if (path.length === 0) throw new Error("INVALID_AUDIT_ENDPOINT");
  const server = Bun.listen({ unix: path, socket: socketHandler });
  writeFileSync(join(config.dir, "endpoint"), `${config.endpoint}\n`, "utf8");
  void server;
}

try {
  main();
} catch (error) {
  console.error(`AUDIT_DAEMON_FATAL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
