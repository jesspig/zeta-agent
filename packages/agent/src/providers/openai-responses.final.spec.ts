import { describe, expect, test } from "bun:test";
import { createOpenAiResponsesStreamFn } from "./openai-responses";
import type { AgentStreamChunk } from "../facade";

function sse(frames: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const f of frames) c.enqueue(encoder.encode(f));
        c.close();
      },
    }),
    { status: 200 },
  );
}

async function collect(iter: AsyncIterable<AgentStreamChunk>): Promise<AgentStreamChunk[]> {
  const out: AgentStreamChunk[] = [];
  for await (const c of iter) out.push(c);
  return out;
}

/** CR-08：未确认成功终态时不得交付工具调用。 */
describe("T-08 Responses 流终态门槛", () => {
  test("response.incomplete 终态不交付未完成工具调用", async () => {
    const fake = (async () =>
      sse([
        'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"c1","name":"read"}}\n\n',
        'data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"a\\":1}"}\n\n',
        'data: {"type":"response.incomplete","response":{"status":"incomplete"}}\n\n',
      ])) as unknown as typeof fetch;
    const chunks = await collect(
      createOpenAiResponsesStreamFn(
        { baseUrl: "https://api.test/v1", apiKey: "k", model: "m" },
        fake,
      )({ messages: [] }),
    );
    expect(chunks.at(-1)).toMatchObject({ type: "done", stopReason: "length" });
    expect(chunks.filter((c) => typeof c === "object" && c.type === "tool_call")).toHaveLength(0);
  });

  test("成功终态后交付完整工具调用", async () => {
    const fake = (async () =>
      sse([
        'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"c1","name":"read"}}\n\n',
        'data: {"type":"response.function_call_arguments.done","output_index":0,"item":{"arguments":"{\\"a\\":1}"}}\n\n',
        'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","call_id":"c1","name":"read","arguments":"{\\"a\\":1}"}}\n\n',
        'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
      ])) as unknown as typeof fetch;
    const chunks = await collect(
      createOpenAiResponsesStreamFn(
        { baseUrl: "https://api.test/v1", apiKey: "k", model: "m" },
        fake,
      )({ messages: [] }),
    );
    expect(chunks.filter((c) => typeof c === "object" && c.type === "tool_call")).toHaveLength(1);
  });
});
