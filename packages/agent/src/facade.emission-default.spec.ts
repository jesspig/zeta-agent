import { describe, expect, test } from "bun:test";
import type { AgentMessage, AgentStreamChunk } from "./facade";
import { createAgent } from "./facade";

interface Call {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

interface EmissionDefaultHarness {
  readonly agent: ReturnType<typeof createAgent>;
  readonly executions: () => number;
  readonly executed: () => readonly Call[];
  /** probe 工具的 after 钩子在批次内观察到的 write 执行次数（commit 前应为 0）。 */
  readonly observedDuringBatch: () => readonly number[];
  readonly toolResults: () => readonly AgentMessage[];
}

/**
 * 首回合发出给定的 tool_call 批次，次回合文本收束；
 * 工具注册表拿到的是 facade 默认发射策略，不注入 durableEffects / emissionTools。
 */
function emissionDefaultHarness(options: {
  readonly calls: readonly Call[];
  readonly emissionPolicy?: "withhold" | "direct";
}): EmissionDefaultHarness {
  let turn = 0;
  let executions = 0;
  const executed: Call[] = [];
  const observedDuringBatch: number[] = [];

  const agent = createAgent({
    includeBuiltins: false,
    emissionPolicy: options.emissionPolicy,
    streamFn: async function* (): AsyncIterable<AgentStreamChunk> {
      turn += 1;
      if (turn === 1) {
        for (const [index, call] of options.calls.entries()) {
          yield {
            type: "tool_call",
            id: `c${index + 1}`,
            name: call.name,
            arguments: JSON.stringify(call.args),
          };
        }
        return;
      }
      yield "done";
    },
  });

  for (const name of new Set(options.calls.map((call) => call.name))) {
    agent.api.registerTool({
      name,
      description: name,
      parameters: [],
      execute: (args: Readonly<Record<string, unknown>>) => {
        executions += 1;
        executed.push({ name, args });
        return { ok: true, tool: name, args };
      },
    } as never);
  }
  // probe 是非发射工具：它的 after 钩子在 commit 之前运行，可观测批次内是否已有真实副作用。
  agent.api.registerTool({
    name: "probe",
    description: "probe",
    parameters: [],
    execute: () => "PROBED",
  } as never);
  agent.api.addAfterToolCall((event) => {
    if (event.type === "tool_execution_end" && event.toolName === "probe") observedDuringBatch.push(executions);
  });

  return {
    agent,
    executions: () => executions,
    executed: () => [...executed],
    observedDuringBatch: () => [...observedDuringBatch],
    toolResults: () => [...agent.state.messages].reverse().filter((message) => message.role === "toolResult"),
  };
}

describe("T-08 发射工具默认 withhold（AC-11）", () => {
  test("① 默认 withhold：commit 前无副作用，commit 后恰好派发一次", async () => {
    const args = { path: "/tmp/default-emission-a.txt", content: "a" };
    const harness = emissionDefaultHarness({
      calls: [
        { name: "write", args },
        { name: "probe", args: {} },
      ],
    });

    // prompt 之前：既没有 enqueue 引起的执行，也没有回执。
    expect(harness.executions()).toBe(0);
    expect(harness.agent.emissionReceipts()).toHaveLength(0);

    await harness.agent.prompt("go");

    // probe 的 after 钩子在批次内触发时 write 尚未执行（commit 还没发生）。
    expect(harness.observedDuringBatch()).toEqual([0]);
    // commit 后真实执行恰好一次，回执恰好一条。
    expect(harness.executions()).toBe(1);
    expect(harness.executed()).toEqual([{ name: "write", args }]);
    const receipts = harness.agent.emissionReceipts();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.kind).toBe("write");
    expect(receipts[0]?.ok).toBe(true);
    expect(receipts[0]?.key).toMatch(/^write:/);
    // 对外仍呈现真实执行结果，既有工具的返回契约不回归。
    const writeResult = harness.toolResults().find((message) => message.toolName === "write");
    expect(writeResult?.content).toEqual({ ok: true, tool: "write", args });
  });

  test("② 重复 (kind,key) 只派发一次", async () => {
    const same = { path: "/tmp/default-emission-same.txt", content: "same" };
    const harness = emissionDefaultHarness({
      calls: [
        { name: "write", args: same },
        { name: "write", args: { ...same } },
        { name: "write", args: { path: "/tmp/default-emission-other.txt", content: "other" } },
      ],
    });

    await harness.agent.prompt("go");

    // 三条调用、两个不同的 (kind,key) → 只执行并派发两次。
    expect(harness.executions()).toBe(2);
    expect(harness.executed().map((item) => item.args.path)).toEqual([
      "/tmp/default-emission-same.txt",
      "/tmp/default-emission-other.txt",
    ]);
    const receipts = harness.agent.emissionReceipts();
    expect(receipts).toHaveLength(2);
    expect(new Set(receipts.map((receipt) => receipt.key)).size).toBe(2);
  });

  test("③ emissionPolicy:'direct' 完全绕过 withhold，立即执行且不产生回执", async () => {
    const args = { path: "/tmp/default-emission-direct.txt", content: "d" };
    const harness = emissionDefaultHarness({
      emissionPolicy: "direct",
      calls: [
        { name: "write", args },
        { name: "write", args: { ...args } },
        { name: "probe", args: {} },
      ],
    });

    await harness.agent.prompt("go");

    // 两条重复调用都立即执行（direct 下不去重），probe 的 after 钩子看到 write 已执行两次。
    expect(harness.executions()).toBe(2);
    expect(harness.observedDuringBatch()).toEqual([2]);
    expect(harness.agent.emissionReceipts()).toHaveLength(0);
    const writeResults = harness.toolResults().filter((message) => message.toolName === "write");
    expect(writeResults).toHaveLength(2);
    expect(writeResults[0]?.content).toEqual({ ok: true, tool: "write", args });
  });

  test("④ 不注入任何发射相关选项时既有工具路径与测试基线一致", async () => {
    let turn = 0;
    let executions = 0;
    const agent = createAgent({
      streamFn: async function* (): AsyncIterable<AgentStreamChunk> {
        turn += 1;
        if (turn === 1) {
          yield { type: "tool_call", id: "c1", name: "probe", arguments: "{}" };
          return;
        }
        yield "done";
      },
    });
    agent.api.registerTool({
      name: "probe",
      description: "probe",
      parameters: [],
      execute: () => {
        executions += 1;
        return "OK";
      },
    } as never);

    await agent.prompt("go");

    expect(turn).toBe(2);
    expect(executions).toBe(1);
    expect(agent.emissionReceipts()).toEqual([]);
  });
});
