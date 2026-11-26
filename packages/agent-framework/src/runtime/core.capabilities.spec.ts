import { describe, expect, test } from "bun:test";
import { createAgent } from "./core";

describe("T-25 public core capability honesty", () => {
  test("未注入安全能力时默认全部报告 unsupported", () => {
    const agent = createAgent();

    expect(agent.api.capabilities()).toEqual({
      isolation: "unsupported",
      seccomp: "unsupported",
      fsConfinement: "unsupported",
      auditSink: "unsupported",
      egressDefaultDeny: "unsupported",
    });
  });

  test("显式注入的能力报告原样返回", () => {
    const capabilities = {
      isolation: "degraded",
      seccomp: "unsupported",
      fsConfinement: "active",
      auditSink: "disabled",
      egressDefaultDeny: "active",
    } as const;
    const agent = createAgent({ capabilities: () => capabilities });

    expect(agent.api.capabilities()).toEqual(capabilities);
  });
});
