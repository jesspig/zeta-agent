import { describe, expect, test } from "bun:test";
import type { AgentStreamChunk, AgentStreamFn } from "../facade";
import { createProviderBroker } from "./broker";

async function collect(iterable: AsyncIterable<AgentStreamChunk>): Promise<AgentStreamChunk[]> {
  return await Array.fromAsync(iterable);
}

function stream(text: string): AgentStreamFn {
  return async function* () { yield text; yield { type: "done", stopReason: "stop" }; };
}

describe("T-07 provider broker", () => {
  test("按 model provider 前缀路由，失败时 fallback", async () => {
    const broker = createProviderBroker({ fallback: ["b"] });
    const calls: string[] = [];
    broker.register("a", async function* () {
      calls.push("a");
      yield { type: "error", error: { code: "server", message: "down", status: 503 } };
    });
    broker.register("b", async function* () { calls.push("b"); yield "fallback"; yield { type: "done", stopReason: "stop" }; });
    const chunks = await collect(broker.stream({ messages: [], model: "a/model" }));
    expect(calls).toEqual(["a", "b"]);
    expect(chunks).toContain("fallback");
  });

  test("显式 provider 优先于路由表，未注册时产出 error 终态", async () => {
    const broker = createProviderBroker({ routes: { a: ["a"], "*": ["b"] } });
    broker.register("a", stream("a"));
    broker.register("b", stream("b"));
    expect(await collect(broker.stream({ messages: [], provider: "b", model: "a/model" }))).toContain("b");
    const missing = createProviderBroker();
    expect((await collect(missing.stream({ messages: [], provider: "none" }))).at(-1)).toMatchObject({
      type: "error",
      error: { code: "provider_not_found" },
    });
  });

  test("热更新只影响新请求，观察钩子收到 route 与 stream event", async () => {
    const observed: string[] = [];
    const broker = createProviderBroker({
      onRoute: (route) => { observed.push(`route:${route}`); },
      onProviderStreamEvent: (provider, chunk) => { observed.push(`${provider}:${typeof chunk === "string" ? "text" : chunk.type}`); },
    });
    broker.register("a", stream("old"));
    const first = broker.stream({ messages: [], provider: "a" });
    broker.register("a", stream("new"));
    expect(await collect(first)).toContain("old");
    expect(await collect(broker.stream({ messages: [], provider: "a" }))).toContain("new");
    expect(observed).toContain("route:a");
    expect(observed).toContain("a:done");
  });

  test("注册 disposer 与 setRoutes 可逆", async () => {
    const broker = createProviderBroker();
    const dispose = broker.register("a", stream("a"));
    dispose();
    const last = (await collect(broker.stream({ messages: [], provider: "a" }))).at(-1);
    expect(typeof last === "object" ? last.type : undefined).toBe("error");
    broker.register("a", stream("a"));
    broker.register("b", stream("b"));
    broker.setRoutes({ a: ["b"] });
    expect(await collect(broker.stream({ messages: [], model: "a/model" }))).toContain("b");
  });
});
