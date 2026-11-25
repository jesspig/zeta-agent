import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUDIT_SIGNING_SECRET_ENV,
  createFileAuditStorage,
  createHmacAuditSigner,
  defaultHash,
  verifyAuditIntegrity,
  type AuditRecord,
} from "./audit";
import { createSocketAuditSink, type SocketAuditSink } from "./audit.socket";

const DAEMON_PATH = join(import.meta.dir, "audit-daemon.ts");
const CLIENT_TOKEN_ENV = "ZETA_AUDIT_CLIENT_TOKEN";

setDefaultTimeout(30_000);

const record = (over: Partial<AuditRecord> = {}): AuditRecord => ({
  ts: 1,
  actor: "agent",
  tenant: "tenant-a",
  pluginId: "plugin-1",
  toolName: "tool",
  argsDigest: "args-digest",
  decision: "allow",
  resultDigest: "result-digest",
  causalId: "run-1",
  ...over,
});

interface Daemon {
  readonly endpoint: string;
  readonly proc: ReturnType<typeof Bun.spawn>;
  stop(): Promise<void>;
}

async function startDaemon(dir: string, secret: string, token: string): Promise<Daemon> {
  const endpointPath = join(dir, "endpoint");
  try {
    rmSync(endpointPath, { force: true });
  } catch {
    // 目录第一次启动时没有 endpoint 文件。
  }
  const proc = Bun.spawn([process.execPath, DAEMON_PATH], {
    env: {
      ...process.env,
      [AUDIT_SIGNING_SECRET_ENV]: secret,
      [CLIENT_TOKEN_ENV]: token,
      ZETA_AUDIT_ENDPOINT: "tcp:127.0.0.1:0",
      ZETA_AUDIT_DIR: dir,
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  let endpoint = "";
  for (let attempt = 0; attempt < 500 && endpoint.length === 0; attempt += 1) {
    if (existsSync(endpointPath)) endpoint = readFileSync(endpointPath, "utf8").trim();
    if (endpoint.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (endpoint.length === 0) {
    proc.kill();
    await proc.exited;
    const stderr = await new Response(proc.stderr).text().catch(() => "");
    throw new Error(`daemon 未就绪: ${stderr}`);
  }
  let stopped = false;
  return {
    endpoint,
    proc,
    async stop() {
      if (stopped) return;
      stopped = true;
      proc.kill();
      await proc.exited;
    },
  };
}

async function client(endpoint: string, token: string): Promise<SocketAuditSink> {
  const sink = createSocketAuditSink({ endpoint, token });
  await sink.ready();
  return sink;
}

describe("T-14 IF-13 审计 daemon 认证 / ack / 重启恢复", () => {
  test("客户端认证：错误 token 的 append/verify 被拒，正确 token 通过", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zeta-audit-auth-"));
    const secret = randomBytes(24).toString("hex");
    const token = randomBytes(16).toString("hex");
    const daemon = await startDaemon(dir, secret, token);
    try {
      const bad = await client(daemon.endpoint, "wrong-token");
      let message = "";
      try {
        await bad.appendAck(record({ toolName: "bad" }));
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain("UNAUTHORIZED");
      await bad.close();

      const good = await client(daemon.endpoint, token);
      const entry = await good.appendAck(record({ toolName: "good" }));
      expect(entry.seq).toBe(0);
      expect(good.ackedSeq()).toBe(0);
      await good.close();
    } finally {
      await daemon.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("append ack + flush：确认后本地与远端立即可见，无需额外等待", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zeta-audit-ack-"));
    const secret = randomBytes(24).toString("hex");
    const token = randomBytes(16).toString("hex");
    const daemon = await startDaemon(dir, secret, token);
    try {
      const sink = await client(daemon.endpoint, token);
      const first = await sink.appendAck(record({ toolName: "a" }));
      const second = await sink.appendAck(record({ toolName: "b" }));
      expect([first.seq, second.seq]).toEqual([0, 1]);
      expect(sink.ackedSeq()).toBe(1);
      await sink.flush();
      await sink.finalizeRemote(2, "complete");
      expect(await sink.verifyRemote(2)).toEqual({ ok: true, entries: 2, finalized: "complete" });
      await sink.close();
    } finally {
      await daemon.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("重启链恢复：重启后 seq 延续、封存校验通过；篡改落盘链后 daemon 拒绝启动", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zeta-audit-restart-"));
    const secret = randomBytes(24).toString("hex");
    const token = randomBytes(16).toString("hex");
    let daemon = await startDaemon(dir, secret, token);
    let failed: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const sink = await client(daemon.endpoint, token);
      await sink.appendAck(record({ toolName: "a" }));
      await sink.appendAck(record({ toolName: "b" }));
      await sink.finalizeRemote(2, "complete");
      await sink.close();
      await daemon.stop();

      daemon = await startDaemon(dir, secret, token);
      const again = await client(daemon.endpoint, token);
      const third = await again.appendAck(record({ toolName: "c" }));
      expect(third.seq).toBe(2);
      const finalized = await again.finalizeRemote(3, "complete");
      expect(finalized.seq).toBe(3);
      expect(await again.verifyRemote(3)).toEqual({ ok: true, entries: 3, finalized: "complete" });
      await again.close();

      const storage = createFileAuditStorage(dir);
      expect(
        verifyAuditIntegrity({ storage, hash: defaultHash, sign: createHmacAuditSigner(secret), revision: 3 })
      ).toEqual({ ok: true, entries: 3, finalized: "complete" });
      await daemon.stop();
      daemon = await startDaemon(dir, secret, token);

      const logPath = join(dir, "audit-append.log");
      const lines = readFileSync(logPath, "utf8").split(/\r?\n/).filter((line) => line.length > 0);
      const tampered = JSON.parse(lines[0]!) as { entry: { record: AuditRecord } };
      tampered.entry.record = { ...tampered.entry.record, decision: "DENY" };
      writeFileSync(logPath, [JSON.stringify(tampered), ...lines.slice(1), ""].join("\n"), "utf8");
      await daemon.stop();
      failed = Bun.spawn([process.execPath, DAEMON_PATH], {
        env: {
          ...process.env,
          [AUDIT_SIGNING_SECRET_ENV]: secret,
          [CLIENT_TOKEN_ENV]: token,
          ZETA_AUDIT_ENDPOINT: "tcp:127.0.0.1:0",
          ZETA_AUDIT_DIR: dir,
        },
        stdout: "ignore",
        stderr: "pipe",
      });
      const code = await failed.exited;
      if (failed.stderr === undefined || typeof failed.stderr === "number") throw new Error("AUDIT_DAEMON_STDERR_UNAVAILABLE");
      const stderr = await new Response(failed.stderr).text();
      expect(code).not.toBe(0);
      expect(stderr).toContain("AUDIT_CHAIN_RECOVERY_FAILED");
    } finally {
      failed?.kill();
      if (failed !== undefined) await failed.exited.catch(() => {});
      await daemon.stop().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("多客户端并发 append 后统一校验：序号连续、无丢条", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zeta-audit-multi-"));
    const secret = randomBytes(24).toString("hex");
    const token = randomBytes(16).toString("hex");
    const daemon = await startDaemon(dir, secret, token);
    try {
      const a = await client(daemon.endpoint, token);
      const b = await client(daemon.endpoint, token);
      const results = await Promise.all([
        a.appendAck(record({ toolName: "a1" })),
        b.appendAck(record({ toolName: "b1" })),
        a.appendAck(record({ toolName: "a2" })),
        b.appendAck(record({ toolName: "b2" })),
      ]);
      expect(results.map((entry) => entry.seq).sort()).toEqual([0, 1, 2, 3]);
      await Promise.all([a.flush(), b.flush()]);
      await a.finalizeRemote(4, "complete");
      expect(await a.verifyRemote(4)).toEqual({ ok: true, entries: 4, finalized: "complete" });
      await a.close();
      await b.close();
    } finally {
      await daemon.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("revision/seq/head 任一被篡改，封存校验失败", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zeta-audit-head-"));
    const secret = randomBytes(24).toString("hex");
    const token = randomBytes(16).toString("hex");
    const daemon = await startDaemon(dir, secret, token);
    try {
      const sink = await client(daemon.endpoint, token);
      await sink.appendAck(record());
      await sink.finalizeRemote(1, "complete");
      await sink.close();
      const markerPath = join(dir, "audit-final-1.json");
      const original = readFileSync(markerPath, "utf8");

      for (const field of ["head", "seq", "revision"] as const) {
        const marker = JSON.parse(original) as Record<string, unknown>;
        marker[field] = field === "head" ? "deadbeef" : Number(marker[field]) + 1;
        writeFileSync(markerPath, JSON.stringify(marker), "utf8");
        const probe = await client(daemon.endpoint, token);
        const result = await probe.verifyRemote(1);
        expect(result.ok).toBe(false);
        expect(result.reason).toBe("FINALIZED_MISMATCH");
        await probe.close();
        writeFileSync(markerPath, original, "utf8");
      }
    } finally {
      await daemon.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
