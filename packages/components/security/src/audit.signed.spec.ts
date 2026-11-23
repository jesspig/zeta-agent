import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAuditSink,
  createFileAuditStorage,
  createHmacAuditSigner,
  verifyAuditChain,
  verifyAuditIntegrity,
  type AuditRecord,
} from "./audit";

const hash = (input: string): string => {
  let value = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    value ^= input.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return (value >>> 0).toString(16);
};

// 测试专用占位密钥，不是任何真实凭据。
const sign = createHmacAuditSigner("test-only-signing-key");

function record(over: Partial<AuditRecord> = {}): AuditRecord {
  return {
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
  };
}

describe("A23 进程外 append-only 签名审计", () => {
  test("落盘 append-only 日志 + finalized 标记，完整性校验通过", () => {
    const dir = mkdtempSync(join(tmpdir(), "zeta-signed-audit-"));
    try {
      const storage = createFileAuditStorage(dir);
      const sink = createAuditSink({ hash, storage, sign });

      sink.append(record({ toolName: "tool-a" }));
      sink.append(record({ toolName: "tool-b" }));
      expect(sink.finalized(2)).toBe("complete");

      const lines = storage.readLines();
      expect(lines).toHaveLength(2);
      expect(storage.readMarker(2)).toBeDefined();

      const result = verifyAuditIntegrity({ storage, hash, sign, revision: 2 });
      expect(result).toEqual({ ok: true, entries: 2, finalized: "complete" });
      expect(sink.entries).toHaveLength(2);

      sink.noteDrop();
      expect(sink.finalized(2)).toBe("complete-with-drops");
      expect(verifyAuditIntegrity({ storage, hash, sign, revision: 2 }).finalized).toBe("complete-with-drops");
      expect(sink.finalized(3)).toBe("incomplete");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("篡改已落盘审计行或 finalized 标记均被检测", () => {
    const dir = mkdtempSync(join(tmpdir(), "zeta-signed-audit-"));
    try {
      const storage = createFileAuditStorage(dir);
      const sink = createAuditSink({ hash, storage, sign });
      sink.append(record());
      sink.append(record({ ts: 2, toolName: "tool-b" }));
      sink.finalized(2);

      const logPath = join(dir, "audit-append.log");
      const lines = storage.readLines();
      const first = JSON.parse(lines[0]!) as { entry: { record: AuditRecord }; signature: string };
      first.entry.record = { ...first.entry.record, decision: "DENY" };
      writeFileSync(logPath, [JSON.stringify(first), lines[1], ""].join("\n"), "utf8");

      const tampered = verifyAuditIntegrity({ storage, hash, sign, revision: 2 });
      expect(tampered.ok).toBe(false);
      expect(tampered.reason).toMatch(/MISMATCH|CHAIN_BREAK/);
      expect(readFileSync(logPath, "utf8")).toContain("DENY");

      // 恢复原行后篡改 finalized 标记本身，同样必须失败。
      writeFileSync(logPath, [...lines, ""].join("\n"), "utf8");
      expect(verifyAuditIntegrity({ storage, hash, sign, revision: 2 }).ok).toBe(true);
      const markerPath = join(dir, "audit-final-2.json");
      const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { finalized: string };
      marker.finalized = "incomplete";
      writeFileSync(markerPath, JSON.stringify(marker), "utf8");
      expect(verifyAuditIntegrity({ storage, hash, sign, revision: 2 }).reason).toBe("FINALIZED_MISMATCH");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("默认内存实现不注入存储，既有 hash 链语义保持不变", () => {
    const sink = createAuditSink({ hash });
    sink.append(record({ toolName: "memory-only" }));
    expect(sink.finalized(1)).toBe("complete");
    expect(verifyAuditChain(sink.entries, hash)).toBe(true);
  });
});
