import { describe, expect, test } from "bun:test";
import { createAgent, type AgentStreamRequest } from "./facade";
import { createOpenAiStreamFn } from "./providers/openai";

/** CR-07：abort 必须传播到 provider 的 fetch，中断等待中的网络请求。 */
describe("T-07 取消传播", () => {
  test("facade 为每次流请求提供 AbortSignal，abort 后传到 fetch", async () => {
    let requestSignal: AbortSignal | undefined;
    let fetchSignal: AbortSignal | undefined;
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      fetchSignal = (init as RequestInit & { signal?: AbortSignal })?.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            fetchSignal?.addEventListener("abort", () => controller.close());
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const agent = createAgent({
      streamFn: (request: AgentStreamRequest) => {
        requestSignal = request.signal;
        return createOpenAiStreamFn(
          { baseUrl: "https://api.test/v1", apiKey: "k", model: "m" },
          fakeFetch,
        )(request);
      },
    });

    const prompting = agent.prompt("go");
    for (let i = 0; i < 100 && requestSignal === undefined; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(requestSignal).toBeDefined();
    agent.abort();
    expect(requestSignal?.aborted).toBe(true);
    expect(fetchSignal).toBe(requestSignal);
    await prompting;
  });
});
