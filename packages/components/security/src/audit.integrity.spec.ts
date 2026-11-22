import { describe, expect, test } from "bun:test";
import { createAuditSink, verifyAuditChain, type AuditRecord, type AuditEntry } from "./audit";

const record = (over: Partial<AuditRecord> = {}): AuditRecord => ({
  ts: 1, actor: "a", tenant: "t", pluginId: "p", toolName: "tool",
  argsDigest: "d", decision: "allow", resultDigest: "r", causalId: "c", ...over,
});

/** CR-36：审计记录必须是不可变快照，链校验要覆盖序号连续性。 */
describe("T-36 审计链完整性", () => {
  test("外部持有的 record 引用变更不影响已存条目", () => {
    const identity = (x: string) => x;
    const sink = createAuditSink({ hash: identity });
    const input = record();
    const entry = sink.append(input);
    (input as { decision: string }).decision = "DENY"; // 外部修改原对象
    expect(entry.record.decision).toBe("allow");
    expect(verifyAuditChain(sink.entries, identity)).toBe(true);
  });

  test("entries getter 返回副本，外部增删不影响内部", () => {
    const sink = createAuditSink();
    sink.append(record());
    const snapshot = sink.entries as unknown as AuditEntry[];
    snapshot.length = 0;
    expect(sink.entries).toHaveLength(1);
  });

  test("verifyAuditChain 拒绝不连续的序号", () => {
    const sink = createAuditSink();
    sink.append(record());
    sink.append(record({ ts: 2 }));
    const tampered = sink.entries.map((e, i) => i === 1 ? { ...e, seq: 5 } : e);
    expect(verifyAuditChain(tampered, (x) => x)).toBe(false);
  });
});
