import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
import { createSocketAuditSink, parseAuditEndpoint, type SocketAuditSink } from "./audit.socket";

const DAEMON_PATH = join(import.meta.dir, "audit-daemon.ts");

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

interface DaemonHarness {
  readonly dir: string;
  readonly endpoint: string;
  readonly secret: string;
  readonly sink: SocketAuditSink;
  readonly stop: () => Promise<void>;
}

async function startDaemon(): Promise<DaemonHarness> {
  const dir = mkdtempSync(join(tmpdir(), "zeta-audit-daemon-"));
  // 运行时生成测试专用值，只注入 daemon 子进程；仓库中不出现任何密钥字面量。
  const secret = randomBytes(24).toString("hex");
  const token = randomBytes(16).toString("hex");
  const proc = Bun.spawn([process.execPath, DAEMON_PATH], {
    env: {
      ...process.env,
      [AUDIT_SIGNING_SECRET_ENV]: secret,
      ZETA_AUDIT_CLIENT_TOKEN: token,
      ZETA_AUDIT_ENDPOINT: "tcp:127.0.0.1:0",
      ZETA_AUDIT_DIR: dir,
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  const endpointPath = join(dir, "endpoint");
  let endpoint = "";
  for (let attempt = 0; attempt < 500 && endpoint.length === 0; attempt += 1) {
    if (existsSync(endpointPath)) endpoint = readFileSync(endpointPath, "utf8").trim();
    if (endpoint.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (endpoint.length === 0) {
    proc.kill();
    await proc.exited;
    const stderr = await new Response(proc.stderr).text().catch(() => "");
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`审计 daemon 未就绪: ${stderr}`);
  }
  const sink = createSocketAuditSink({ endpoint, token });
  await sink.ready();
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await sink.close();
    proc.kill();
    await proc.exited;
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, endpoint, secret, sink, stop };
}

describe("T-02 A23 进程外审计 daemon", () => {
  test("跨进程 append 落盘、daemon finalize 封存、daemon verify 校验通过", async () => {
    const harness = await startDaemon();
    try {
      harness.sink.append(record({ toolName: "tool-a" }));
      harness.sink.append(record({ toolName: "tool-b" }));
      expect(harness.sink.finalized(2)).toBe("complete");

      const finalized = await harness.sink.finalizeRemote(2, "complete");
      expect(finalized.ok).toBe(true);
      expect(finalized.revision).toBe(2);
      expect(finalized.seq).toBe(2);

      expect(await harness.sink.verifyRemote(2)).toEqual({ ok: true, entries: 2, finalized: "complete" });

      const storage = createFileAuditStorage(harness.dir);
      expect(storage.readLines()).toHaveLength(2);
      const local = verifyAuditIntegrity({
        storage,
        hash: defaultHash,
        sign: createHmacAuditSigner(harness.secret),
        revision: 2,
      });
      expect(local).toEqual({ ok: true, entries: 2, finalized: "complete" });
      const toolNames = storage.readLines().map((line) => (JSON.parse(line) as { entry: { record: AuditRecord } }).entry.record.toolName);
      expect(toolNames).toEqual(["tool-a", "tool-b"]);
    } finally {
      await harness.stop();
    }
  });

  test("签名密钥不进入 endpoint/options/sink/日志/产物/测试进程环境", async () => {
    const harness = await startDaemon();
    try {
      harness.sink.append(record());
      expect((await harness.sink.finalizeRemote(1, harness.sink.finalized(1))).ok).toBe(true);
      expect((await harness.sink.verifyRemote(1)).ok).toBe(true);

      const options = { endpoint: harness.endpoint, queueLimit: 8 };
      expect(JSON.stringify(options)).not.toContain(harness.secret);
      expect(JSON.stringify(harness.sink)).not.toContain(harness.secret);
      expect(Object.keys(harness.sink)).not.toContain("secret");
      expect(process.env[AUDIT_SIGNING_SECRET_ENV]).not.toBe(harness.secret);

      for (const name of readdirSync(harness.dir)) {
        expect(readFileSync(join(harness.dir, name), "utf8")).not.toContain(harness.secret);
      }
      const marker = JSON.parse(readFileSync(join(harness.dir, "audit-final-1.json"), "utf8")) as { signature: string };
      expect(typeof marker.signature).toBe("string");
      expect(marker.signature.length).toBeGreaterThan(0);
    } finally {
      await harness.stop();
    }
  });

  test("篡改落盘审计行或 finalized 标记都被跨进程校验检测", async () => {
    const harness = await startDaemon();
    try {
      harness.sink.append(record({ ts: 1, toolName: "tool-a" }));
      harness.sink.append(record({ ts: 2, toolName: "tool-b" }));
      await harness.sink.finalizeRemote(2, "complete");
      expect((await harness.sink.verifyRemote(2)).ok).toBe(true);

      const logPath = join(harness.dir, "audit-append.log");
      const lines = readFileSync(logPath, "utf8").split(/\r?\n/).filter((line) => line.length > 0);
      const first = JSON.parse(lines[0]!) as { entry: { record: AuditRecord }; signature: string };
      first.entry.record = { ...first.entry.record, decision: "DENY" };
      writeFileSync(logPath, [JSON.stringify(first), lines[1], ""].join("\n"), "utf8");

      const tamperedLine = await harness.sink.verifyRemote(2);
      expect(tamperedLine.ok).toBe(false);
      expect(tamperedLine.reason).toMatch(/HASH_MISMATCH|SIGNATURE_MISMATCH|CHAIN_BREAK|FINALIZED_MISMATCH/);

      writeFileSync(logPath, [...lines, ""].join("\n"), "utf8");
      expect((await harness.sink.verifyRemote(2)).ok).toBe(true);

      const markerPath = join(harness.dir, "audit-final-2.json");
      const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { finalized: string };
      marker.finalized = "incomplete";
      writeFileSync(markerPath, JSON.stringify(marker), "utf8");
      const tamperedMarker = await harness.sink.verifyRemote(2);
      expect(tamperedMarker.ok).toBe(false);
      expect(tamperedMarker.reason).toBe("FINALIZED_MISMATCH");
    } finally {
      await harness.stop();
    }
  });

  test("append 入有界队列不阻塞工具路径；满队列计 drop", () => {
    const sink = createSocketAuditSink({ endpoint: "tcp:127.0.0.1:1", queueLimit: 2, token: "test-only-client-token" });
    void sink.ready().catch(() => {});
    const start = Date.now();
    for (let index = 0; index < 5; index += 1) sink.append(record({ toolName: `t${index}` }));
    expect(Date.now() - start).toBeLessThan(200);
    expect(sink.entries).toHaveLength(5);
    expect(sink.finalized(5)).toBe("complete-with-drops");
    void sink.close();
  });

  test("端点解析只接受显式 unix:/tcp: 形式", () => {
    expect(parseAuditEndpoint("tcp:127.0.0.1:0")).toEqual({ type: "tcp", host: "127.0.0.1", port: 0 });
    expect(parseAuditEndpoint("unix:/tmp/zeta-audit.sock")).toEqual({ type: "unix", path: "/tmp/zeta-audit.sock" });
    expect(() => parseAuditEndpoint("")).toThrow("INVALID_AUDIT_ENDPOINT");
    expect(() => parseAuditEndpoint("secret:whatever")).toThrow("INVALID_AUDIT_ENDPOINT");
  });

  test("daemon 缺少签名密钥时拒绝启动", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zeta-audit-fail-"));
    try {
      const proc = Bun.spawn([process.execPath, DAEMON_PATH], {
        env: {
          ...process.env,
          [AUDIT_SIGNING_SECRET_ENV]: "",
          ZETA_AUDIT_ENDPOINT: "tcp:127.0.0.1:0",
          ZETA_AUDIT_DIR: dir,
        },
        stdout: "ignore",
        stderr: "pipe",
      });
      const code = await proc.exited;
      const stderr = await new Response(proc.stderr).text();
      expect(code).not.toBe(0);
      expect(stderr).toContain("MISSING_AUDIT_SIGNING_SECRET");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
