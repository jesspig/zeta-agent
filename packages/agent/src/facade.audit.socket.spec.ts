import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUDIT_SIGNING_SECRET_ENV,
  createFileAuditStorage,
} from "@zeta-agent/security";
import { createAgent } from "./facade";

const DAEMON_PATH = join(import.meta.dir, "../../components/security/src/audit-daemon.ts");

interface Harness {
  readonly dir: string;
  readonly endpoint: string;
  readonly secret: string;
  readonly stop: () => Promise<void>;
}

async function startDaemon(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "zeta-facade-audit-"));
  const secret = randomBytes(24).toString("hex");
  const proc = Bun.spawn(["bun", DAEMON_PATH], {
    env: {
      ...process.env,
      [AUDIT_SIGNING_SECRET_ENV]: secret,
      ZETA_AUDIT_ENDPOINT: "tcp:127.0.0.1:0",
      ZETA_AUDIT_DIR: dir,
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  const endpointPath = join(dir, "endpoint");
  let endpoint = "";
  for (let attempt = 0; attempt < 100 && endpoint.length === 0; attempt += 1) {
    if (existsSync(endpointPath)) endpoint = readFileSync(endpointPath, "utf8").trim();
    if (endpoint.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (endpoint.length === 0) {
    proc.kill();
    await proc.exited;
    rmSync(dir, { recursive: true, force: true });
    throw new Error("审计 daemon 未就绪");
  }
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    proc.kill();
    await proc.exited;
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, endpoint, secret, stop };
}

function tracedAgent(endpoint: string): ReturnType<typeof createAgent> {
  let turn = 0;
  const agent = createAgent({
    includeBuiltins: false,
    emissionTools: [],
    auditTransport: "socket",
    auditEndpoint: endpoint,
    streamFn: async function* () {
      turn += 1;
      if (turn === 1) {
        yield { type: "tool_call", id: "c1", name: "plain", arguments: "{}" };
        return;
      }
      yield "done";
    },
  });
  agent.api.registerTool({
    name: "plain",
    description: "plain",
    parameters: [],
    execute: () => "OK",
  } as never);
  return agent;
}

describe("T-02 facade 审计传输接线", () => {
  test("socket 默认端点缺失时显式失败", () => {
    expect(() => createAgent({ auditTransport: "socket" })).toThrow("AUDIT_ENDPOINT_REQUIRED");
  });

  test("默认 memory 链路可用且不落任何文件", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zeta-facade-audit-default-"));
    try {
      const agent = createAgent({ auditDir: dir });
      expect(agent.finalizeAudit(0)).toEqual({
        configured: false,
        finalized: "not-configured",
        entries: 0,
        verified: false,
      });
      expect(await agent.finalizeAuditAsync(0)).toEqual({
        configured: false,
        finalized: "not-configured",
        entries: 0,
        verified: false,
      });
      expect(readdirSync(dir)).toHaveLength(0);
      await agent.closeAudit();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("socket 模式：审计记录跨进程落盘，daemon finalize + verify，无旁路文件且密钥不外泄", async () => {
    const harness = await startDaemon();
    const agent = tracedAgent(harness.endpoint);
    try {
      const messages = await agent.prompt("go");
      expect(messages.length).toBeGreaterThan(0);

      const storage = createFileAuditStorage(harness.dir);
      let revision = 0;
      for (let attempt = 0; attempt < 100 && revision === 0; attempt += 1) {
        revision = storage.readLines().length;
        if (revision === 0) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(revision).toBeGreaterThan(0);

      expect(() => agent.finalizeAudit(revision)).toThrow("AUDIT_SOCKET_REQUIRES_ASYNC_FINALIZE");
      const result = await agent.finalizeAuditAsync(revision);
      expect(result.configured).toBe(true);
      expect(result.finalized).toBe("complete");
      expect(result.entries).toBe(revision);
      expect(result.verified).toBe(true);
      expect(result.path).toBeUndefined();

      const decisions = storage.readLines().map((line) => (JSON.parse(line) as { entry: { record: { decision: string } } }).entry.record.decision);
      expect(decisions).toContain("TOOL_EXECUTED");

      const marker = JSON.parse(readFileSync(join(harness.dir, `audit-final-${revision}.json`), "utf8")) as {
        readonly schema: string;
        readonly signature: string;
      };
      expect(marker.schema).toBe("zeta-audit-signed/v1");
      expect(marker.signature.length).toBeGreaterThan(0);
      expect(readdirSync(harness.dir).some((name) => name.startsWith("zeta-audit-chain"))).toBe(false);

      const options = { auditTransport: "socket" as const, auditEndpoint: harness.endpoint };
      expect(JSON.stringify(options)).not.toContain(harness.secret);
      for (const name of readdirSync(harness.dir)) {
        expect(readFileSync(join(harness.dir, name), "utf8")).not.toContain(harness.secret);
      }
    } finally {
      await agent.closeAudit();
      await harness.stop();
    }
  });
});
