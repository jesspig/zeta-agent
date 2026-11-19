import { describe, expect, test } from "bun:test";
import * as facade from "./facade";

describe("T-25 agent facade and plugin assembly", () => {
  test("facade runtime export surface contains only public API", () => {
    expect(Object.keys(facade).sort()).toEqual([
      "DEFAULT_ASSEMBLY",
      "createAgent",
      "defineDurableExtension",
      "definePiExtension",
      "listAssembly",
    ]);
  });

  test("default assembly manifest lists builtins, skills and session but no research seams", () => {
    const assembly = facade.listAssembly();

    expect(assembly).toEqual(facade.DEFAULT_ASSEMBLY);
    expect(assembly).toContain("builtin:read");
    expect(assembly).toContain("builtin:bash");
    expect(assembly).toContain("builtin:edit");
    expect(assembly).toContain("builtin:write");
    expect(assembly).toContain("skills:registry");
    expect(assembly).toContain("session:store");

    for (const id of assembly) {
      expect(id).toMatch(/^(builtin|skills|session):/);
      expect(id).not.toMatch(/seam|research|evolution|rsi|evidence|fitness|experience|strategy/i);
    }
  });

  test("pi and durable extension facades normalize to the same AgentPlugin shape", () => {
    const tool = { name: "echo", execute: (input: string) => input };
    const handler = () => {};

    const fromPi = facade.definePiExtension("ext:pi", (api) => {
      api.registerTool(tool);
      api.on("agent_start", handler);
    });
    const fromDurable = facade.defineDurableExtension("ext:durable", {
      tools: [tool],
      hooks: [{ event: "agent_start", handler }],
    });

    expect(fromPi.kind).toBe("AgentPlugin");
    expect(fromDurable.kind).toBe("AgentPlugin");
    expect(fromPi.contributions.map((item) => item.kind).sort()).toEqual(["hook", "tool"]);
    expect(fromDurable.contributions.map((item) => item.kind).sort()).toEqual(["hook", "tool"]);
    expect(fromPi.contributions.find((item) => item.kind === "tool")).toEqual({
      kind: "tool",
      tool,
    });
  });

  test("createAgent exposes prompt/continue/subscribe/abort/waitForIdle and emits events", async () => {
    const agent = facade.createAgent({
      streamFn: async function* () {
        yield "hello";
      },
    });

    expect(typeof agent.prompt).toBe("function");
    expect(typeof agent.continue).toBe("function");
    expect(typeof agent.subscribe).toBe("function");
    expect(typeof agent.abort).toBe("function");
    expect(typeof agent.waitForIdle).toBe("function");

    const seen: string[] = [];
    const dispose = agent.subscribe((event) => {
      seen.push(event.type);
    });

    const messages = await agent.prompt("hi");
    await agent.waitForIdle();

    expect(seen).toContain("agent_start");
    expect(seen).toContain("turn_start");
    expect(seen).toContain("message_start");
    expect(seen).toContain("message_end");
    expect(seen).toContain("agent_end");
    expect(messages.map((item) => item.content)).toContain("hi");
    expect(messages.map((item) => item.content)).toContain("hello");

    const continued = await agent.continue();
    expect(continued.length).toBeGreaterThan(messages.length);

    dispose();
    agent.abort();
    expect(agent.aborted).toBe(true);
  });
});
