import { describe, expect, test } from "bun:test";
import { createAuditSink, verifyAuditChain, type AuditRecord } from "./audit";

function record(toolName: string): AuditRecord {
  return {
    ts: 1,
    actor: "agent",
    tenant: "tenant-a",
    pluginId: "plugin-1",
    toolName,
    argsDigest: "args-digest",
    decision: "allow",
    resultDigest: "result-digest",
    causalId: "run-1",
  };
}

const hash = (input: string): string => {
  let value = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    value ^= input.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return (value >>> 0).toString(16);
};

describe("T-21 AuditSink", () => {
  test("append 生成 hash 链，seq 递增，校验通过", () => {
    const sink = createAuditSink({ hash });
    const first = sink.append(record("tool-a"));
    const second = sink.append(record("tool-b"));

    expect(first.seq).toBe(0);
    expect(second.seq).toBe(1);
    expect(first.prevHash).toBe("0");
    expect(second.prevHash).toBe(first.hash);
    expect(sink.entries).toHaveLength(2);
    expect(verifyAuditChain(sink.entries, hash)).toBe(true);
  });

  test("篡改条目后 hash 链校验失败", () => {
    const sink = createAuditSink({ hash });
    sink.append(record("tool-a"));
    sink.append(record("tool-b"));

    const tampered = sink.entries.map((entry, index) =>
      index === 0 ? { ...entry, record: record("tool-x") } : entry
    );
    expect(verifyAuditChain(tampered, hash)).toBe(false);
  });

  test("finalized 标记：complete / complete-with-drops / incomplete", () => {
    const sink = createAuditSink({ hash });
    sink.append(record("tool-a"));
    expect(sink.finalized(1)).toBe("complete");
    expect(sink.finalized(2)).toBe("incomplete");

    sink.noteDrop();
    expect(sink.finalized(1)).toBe("complete-with-drops");
    expect(() => sink.finalized(-1)).toThrow("INVALID_REVISION");
  });
});
