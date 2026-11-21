import { describe, expect, test } from "bun:test";

/**
 * agent-core 12 条不变量等价测试（state-and-events.md §13 / pi-baseline.md §9）。
 *
 * 与 tools/invariants.spec.ts 的工具流水线 12 条（inv-tool-）严格区分：
 * 本文件覆盖 agent-core 的 12 条，测试名统一使用 inv-core- 前缀。
 * 每条不变量同时提供 legacy（字段赋值）与 plugin（管线）两版等价断言。
 */

interface InvariantCase {
  readonly id: number;
  readonly name: string;
  readonly legacy: () => void | Promise<void>;
  readonly plugin: () => void | Promise<void>;
}

/**
 * legacy 版：字段赋值路径的最小字段赋值适配器（O-6）。
 * plugin 版：真实管线路径。两版在 cases 中共享同一断言主体 body。
 */
function pair(
  id: number,
  name: string,
  body: (mode: "legacy" | "plugin") => void | Promise<void>
): InvariantCase {
  return {
    id,
    name,
    legacy: () => body("legacy"),
    plugin: () => body("plugin"),
  };
}

/** 占位断言：由 T-02/T-03 逐条替换为真实行为断言。 */
const pending = (_mode: "legacy" | "plugin"): void => {
  expect(true).toBe(true);
};

const INVARIANT_NAMES = [
  "message-end-barrier", // #1
  "completion-order-decoupled", // #2
  "error-aborted-hard-exit", // #3
  "end-keeps-queue", // #4
  "continue-one-request", // #5
  "hook-no-throw", // #6
  "streamfn-no-throw", // #7
  "late-update-dropped", // #8
  "core-no-persistence-provider", // #9
  "terminate-all-batch", // #10
  "runtoolcall-hooks-no-event", // #11
  "system-single-source", // #12
] as const;

const cases: readonly InvariantCase[] = INVARIANT_NAMES.map((name, index) =>
  pair(index + 1, name, pending)
);

describe("T-01 agent-core 不变量双版结构", () => {
  test("inv-core-structure: 每组 12 条 × 2 版", () => {
    expect(cases).toHaveLength(12);
    expect(new Set(cases.map((item) => item.id))).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
    for (const item of cases) {
      expect(typeof item.legacy).toBe("function");
      expect(typeof item.plugin).toBe("function");
    }
  });

  for (const item of cases) {
    describe(`inv-core-${item.id}-${item.name}`, () => {
      test("legacy", async () => {
        await item.legacy();
      });
      test("plugin", async () => {
        await item.plugin();
      });
    });
  }
});
