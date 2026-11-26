import { describe, expect, test } from "bun:test";
import { createAgent } from "./facade";
import { createProviderStreamFn } from "./providers/dispatch";
import { withProviderRetry } from "./providers/retry";

const TERMINAL = {
  type: "done",
  stopReason: "stop",
  usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
  durationMs: 7,
  responseId: "resp-1",
} as const;

describe("T-09 usage 单源", () => {
  test("usage/durationMs/responseId 进入 AssistantMessage、AgentState 与 session/run 汇总", async () => {
    const agent = createAgent({
      includeBuiltins: false,
      streamFn: async function* () {
        yield "answer";
        yield TERMINAL;
      },
    });
    await agent.prompt("one");

    const assistant = agent.state.messages.find((message) => message.role === "assistant" && message.usage !== undefined);
    expect(assistant?.usage).toEqual({ inputTokens: 2, outputTokens: 3, totalTokens: 5 });
    expect(assistant?.durationMs).toBe(7);
    expect(assistant?.responseId).toBe("resp-1");
    expect(agent.state.usage).toMatchObject({ inputTokens: 2, outputTokens: 3, totalTokens: 5 });
    expect(agent.state.durationMs).toBe(7);
    expect(agent.state.responseId).toBe("resp-1");
    expect(agent.usageSummary).toMatchObject({
      inputTokens: 2,
      outputTokens: 3,
      totalTokens: 5,
      durationMs: 7,
      responseId: "resp-1",
      requests: 1,
      errors: 0,
    });
    expect(agent.lastRunUsage().requests).toBe(1);

    await agent.prompt("two");
    expect(agent.usageSummary.requests).toBe(2);
    expect(agent.usageSummary.inputTokens).toBe(4);
    expect(agent.lastRunUsage().inputTokens).toBe(2);
  });

  test("provider conformance 的 usage 不只是 adapter 局部状态，进入 Agent 汇总", async () => {
    const encoder = new TextEncoder();
    const sse = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of [
            'data: {"id":"chat-9","choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
            'data: {"id":"chat-9","choices":[],"usage":{"prompt_tokens":4,"completion_tokens":6,"total_tokens":10}}\n\n',
            "data: [DONE]\n\n",
          ]) controller.enqueue(encoder.encode(frame));
          controller.close();
        },
      }),
      { status: 200 },
    );
    const streamFn = createProviderStreamFn(
      { provider: "openai", model: "gpt-4o", apiKey: "k", baseUrl: "https://usage.test/v1", egress: { allow: [{ host: "usage.test", port: 443 }] } },
      (async () => sse) as unknown as typeof fetch,
    );
    const agent = createAgent({ includeBuiltins: false, streamFn });
    await agent.prompt("hi");
    expect(agent.usageSummary).toMatchObject({
      inputTokens: 4,
      outputTokens: 6,
      totalTokens: 10,
      responseId: "chat-9",
      requests: 1,
    });
  });

  test("错误不计费；重试只在最终成功的一次计入", async () => {
    let attempts = 0;
    const failing = createAgent({
      includeBuiltins: false,
      streamFn: async function* () {
        attempts += 1;
        yield { type: "error", error: { code: "server", message: "down", status: 503 } } as const;
      },
    });
    await failing.prompt("x");
    expect(attempts).toBe(1);
    expect(failing.usageSummary).toMatchObject({ requests: 0, inputTokens: 0, outputTokens: 0, errors: 1 });

    attempts = 0;
    const retrying = createAgent({
      includeBuiltins: false,
      streamFn: withProviderRetry(
        async function* () {
          attempts += 1;
          if (attempts === 1) yield { type: "error", error: { code: "server", message: "down", status: 503 } } as const;
          else yield TERMINAL;
        },
        { maxRetries: 1, sleep: async () => {} },
      ),
    });
    await retrying.prompt("x");
    expect(attempts).toBe(2);
    expect(retrying.usageSummary).toMatchObject({ requests: 1, inputTokens: 2, errors: 0 });
  });
});
