import { describe, expect, test } from "bun:test";
import { createOutbox, withholdEmission, type Emission } from "./emission";

describe("O-9 withholdEmission", () => {
  test("发射副作用进入 outbox：不自动发送、不自动撤销", () => {
    const outbox = createOutbox();
    let revoked = 0;
    const emission: Emission = { id: "e-1", kind: "tool.emit", payload: { ok: true } };

    const handle = withholdEmission(emission, {
      outbox,
      revoke: () => {
        revoked += 1;
      },
    });

    expect(handle.status).toBe("withheld");
    expect(handle.emission).toBe(emission);
    expect(revoked).toBe(0);
    expect(outbox.pending).toHaveLength(1);
    expect(outbox.isWithheld("e-1")).toBe(true);
  });

  test("只有显式 compensation 才触发 revoke 并清除 withheld", () => {
    const outbox = createOutbox();
    let revoked = 0;
    withholdEmission({ id: "e-2", kind: "tool.emit", payload: null }, {
      outbox,
      revoke: () => {
        revoked += 1;
      },
    });

    expect(revoked).toBe(0);
    outbox.compensate("e-2");
    expect(revoked).toBe(1);
    expect(outbox.isWithheld("e-2")).toBe(false);
    expect(outbox.pending).toHaveLength(0);
  });

  test("重复 withhold 与未知 compensation 抛异常", () => {
    const outbox = createOutbox();
    const emission: Emission = { id: "e-3", kind: "tool.emit", payload: null };
    withholdEmission(emission, { outbox });

    expect(() => withholdEmission(emission, { outbox })).toThrow("EMISSION_ALREADY_WITHHELD");
    expect(() => outbox.compensate("missing")).toThrow("UNKNOWN_EMISSION");
  });
});
