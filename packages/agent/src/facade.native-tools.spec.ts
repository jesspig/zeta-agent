import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentStreamChunk } from "./facade";
import { createAgent } from "./facade";

const dir = mkdtempSync(join(tmpdir(), "zeta-native-tools-"));
writeFileSync(join(dir, "a.txt"), "hello-native", "utf8");

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("原生工具调用与推理流（provider tool_calls / reasoning）", () => {
  test("首轮原生 tool_call 执行工具并自动续跑，思考内容保留在消息上", async () => {
    let turn = 0;
    const inputs: unknown[] = [];
    const agent = createAgent({
      allowedDirectories: [dir],
      streamFn: async function* (request): AsyncIterable<AgentStreamChunk> {
        turn += 1;
        inputs.push(request.messages.map((message) => message.role));
        if (turn === 1) {
          yield { type: "reasoning", text: "需要读取文件" };
          yield {
            type: "tool_call",
            id: "call-read-1",
            name: "read",
            arguments: JSON.stringify({ path: join(dir, "a.txt") }),
          };
          return;
        }
        yield "文件内容是 hello-native";
      },
    });

    const events: AgentEvent[] = [];
    agent.subscribe((event) => {
      events.push(event);
    });

    const messages = await agent.prompt("读取 a.txt");
    const assistantMessages = messages.filter((message) => message.role === "assistant");
    expect(assistantMessages.length).toBe(2);
    expect(assistantMessages[0]?.thinking).toBe("需要读取文件");
    expect(assistantMessages[0]?.toolCalls?.[0]?.name).toBe("read");
    expect(String(assistantMessages[1]?.content)).toBe("文件内容是 hello-native");

    const types = events.map((event) => event.type);
    expect(types).toContain("tool_execution_start");
    expect(types).toContain("tool_execution_end");
    const end = events.find((event) => event.type === "tool_execution_end");
    expect(end !== undefined && end.type === "tool_execution_end" ? end.isError : true).toBe(false);

    const toolResult = messages.find((message) => message.role === "toolResult");
    expect(JSON.stringify(toolResult?.content)).toContain("hello-native");
    // 第二轮请求应携带工具结果，让模型消费。
    expect(inputs[1]).toContain("toolResult");
  });

  test("纯文本回合不会无限续跑", async () => {
    let calls = 0;
    const agent = createAgent({
      streamFn: async function* () {
        calls += 1;
        yield "once";
      },
    });
    await agent.prompt("hi");
    expect(calls).toBe(1);
  });
});
