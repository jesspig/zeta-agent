import { describe, expect, test } from "bun:test";
import { createContributionHost, type ContributionExecutors } from "./contribution-host";
import type { PluginContribution } from "./types";

function executors(calls: string[]): ContributionExecutors {
  const make = (kind: string) => () => {
    calls.push(kind);
    return () => {
      calls.push(`${kind}:disposed`);
    };
  };
  return {
    tool: make("tool"),
    hook: make("hook"),
    section: make("section"),
    wrap: make("wrap"),
    task: make("task"),
    service: make("service"),
  };
}

const ALL: readonly PluginContribution[] = [
  { kind: "tool", tool: { name: "t", execute: () => 1 } },
  { kind: "hook", event: "agent_start", handler: () => undefined },
  { kind: "section", text: "section" },
  { kind: "wrap", name: "wrap" },
  { kind: "task", name: "task" },
  { kind: "service", name: "service" },
];

describe("T-16 六类 contribution 全部接入真实执行器", () => {
  test("applyAll 把每一类分派给对应执行器", () => {
    const calls: string[] = [];
    const host = createContributionHost(executors(calls));
    const disposers = host.applyAll(ALL, { order: 1 });
    expect(calls).toEqual(["tool", "hook", "section", "wrap", "task", "service"]);
    expect(disposers).toHaveLength(6);
    expect(host.applied).toHaveLength(6);
  });

  test("单个 disposer 精确撤销自己的贡献且幂等", () => {
    const calls: string[] = [];
    const host = createContributionHost(executors(calls));
    const [first, second] = host.applyAll(ALL, { order: 1 });
    first?.();
    first?.();
    expect(calls.filter((item) => item === "tool:disposed")).toHaveLength(1);
    expect(host.applied.map((entry) => entry.item.kind)).toEqual([
      "hook", "section", "wrap", "task", "service",
    ]);
    expect(second).toBeDefined();
  });

  test("disposeAll 按 LIFO 撤销全部贡献", () => {
    const calls: string[] = [];
    const host = createContributionHost(executors(calls));
    host.applyAll(ALL, { order: 1 });
    host.disposeAll();
    expect(calls.filter((item) => item.endsWith(":disposed"))).toEqual([
      "service:disposed", "task:disposed", "wrap:disposed", "section:disposed", "hook:disposed", "tool:disposed",
    ]);
    expect(host.applied).toEqual([]);
  });
});
