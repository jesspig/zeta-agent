import { describe, expect, test } from "bun:test";
import {
  createPluginSource,
  evaluatePluginSource,
  type IsolatedPlugin,
} from "@zeta-agent/agent-framework";
import { createAgent } from "./facade";

const HOST_KEYS = ["__T13_FACADE_INSTALL", "__T13_FACADE_HOOK"];

function clearHostMarkers(): void {
  for (const key of HOST_KEYS) delete (globalThis as Record<string, unknown>)[key];
}

async function close(plugin: IsolatedPlugin | undefined): Promise<void> {
  if (plugin !== undefined && !plugin.closed) await plugin.terminate();
}

describe("T-13 facade 信任收口：untrusted 不获得宿主执行路径", () => {
  test("untrusted 隔离插件的 install 不被宿主调用，hook 不进宿主链，service/tool 不注册", async () => {
    clearHostMarkers();
    const plugin = await evaluatePluginSource(
      createPluginSource(
        "untrusted",
        `
        globalThis.__T13_FACADE_INSTALL = "child-only";
        api.addSection("UNTRUSTED SECTION");
        api.registerTool({ name: "untrusted-tool", execute: function () { return "pwn"; } });
        api.provide("untrusted-service", 1);
        api.on("agent_start", function () { globalThis.__T13_FACADE_HOOK = true; });
        api.onInstall(function () { globalThis.__T13_FACADE_INSTALL = true; });
        `,
        { trusted: false, origin: "remote", capabilities: ["prompt:section", "events:on"] }
      )
    );
    try {
      const agent = createAgent({
        includeBuiltins: false,
        plugins: [plugin],
        pluginPolicy: {
          allowedCapabilities: ["prompt:section", "events:on"],
          digestRequired: true,
          untrusted: "sandbox",
        },
        streamFn: async function* () {
          return;
        },
      });
      await agent.prompt("go");
      expect((globalThis as Record<string, unknown>).__T13_FACADE_INSTALL).toBeUndefined();
      expect((globalThis as Record<string, unknown>).__T13_FACADE_HOOK).toBeUndefined();
      expect(agent.toolNames).not.toContain("untrusted-tool");
      expect(agent.pluginServices.map((item) => item.name)).not.toContain("untrusted-service");
      expect(agent.pluginSections.map((item) => item.text)).toContain("UNTRUSTED SECTION");
      expect(plugin.report.capabilities.every((item) => item.executableInHost === false)).toBe(true);
      agent.disposeAll();
    } finally {
      await close(plugin);
      clearHostMarkers();
    }
  });

  test("untrusted 声明可信身份/伪装成功也无法进入宿主 hook 链", async () => {
    clearHostMarkers();
    const plugin = await evaluatePluginSource(
      createPluginSource(
        "pretender",
        `
        api.addSection("PRE TENDER");
        api.on("agent_start", function () { globalThis.__T13_FACADE_HOOK = true; });
        api.onInstall(function () { globalThis.__T13_FACADE_INSTALL = true; });
        `,
        { trusted: false, origin: "generated", capabilities: ["prompt:section"] }
      )
    );
    try {
      const agent = createAgent({
        includeBuiltins: false,
        plugins: [plugin],
        pluginPolicy: { allowedCapabilities: ["prompt:section"], digestRequired: true, untrusted: "sandbox" },
        streamFn: async function* () {
          return;
        },
      });
      await agent.prompt("go");
      expect((globalThis as Record<string, unknown>).__T13_FACADE_HOOK).toBeUndefined();
      expect((globalThis as Record<string, unknown>).__T13_FACADE_INSTALL).toBeUndefined();
      expect(agent.pluginReviews[0]?.review.decision).toBe("sandboxed");
      agent.disposeAll();
    } finally {
      await close(plugin);
      clearHostMarkers();
    }
  });
});

describe("T-13 facade trusted 正向路径：贡献经受限 IPC 代理真实可用", () => {
  test("trusted 插件的 section/hook/install/tool 全部生效，工具经 IPC 执行", async () => {
    clearHostMarkers();
    const plugin = await evaluatePluginSource(
      createPluginSource(
        "trusted",
        `
        var hookFired = false;
        api.addSection("TRUSTED SECTION");
        api.registerTool({
          name: "add-one",
          parameters: [{ name: "n", type: "number", required: true }],
          execute: function (input) { return String(Number(input.n) + 1) + ":hookFired=" + hookFired; }
        });
        api.on("agent_start", function () { hookFired = true; });
        api.onInstall(function () { return "installed"; });
        `,
        { trusted: true, origin: "user", capabilities: ["prompt:section", "events:on", "tools:read"] }
      )
    );
    try {
      const agent = createAgent({
        includeBuiltins: false,
        plugins: [plugin],
        allowTextToolMarkers: true,
        streamFn: async function* () {
          yield '@@TOOL:add-one:{"n":41}@@';
        },
      });
      const messages = await agent.prompt("go");
      const toolResult = messages.find((message) => message.role === "toolResult");
      expect(JSON.stringify(toolResult?.content)).toContain("42:hookFired=true");
      expect(agent.toolNames).toContain("add-one");
      expect(agent.pluginSections.map((item) => item.text)).toContain("TRUSTED SECTION");
      expect((await plugin.installPromise)?.ok).toBe(true);
      expect(plugin.report.capabilities.find((item) => item.kind === "tool")?.executableInHost).toBe(true);
      agent.disposeAll();
    } finally {
      await close(plugin);
      clearHostMarkers();
    }
  });

  test("宿主把 T-11 出站 / T-12 confinement 注入 IPC 门禁，工具参数越界被拒", async () => {
    const plugin = await evaluatePluginSource(
      createPluginSource(
        "gated-facade",
        `api.registerTool({ name: "gated", execute: function () { return "reached"; } });`,
        { trusted: true, origin: "user", capabilities: ["tools:read"] }
      )
    );
    try {
      const toolId = plugin.report.capabilities.find((item) => item.kind === "tool")?.handlerId;
      if (toolId === undefined) throw new Error("missing tool handler");
      const agent = createAgent({ includeBuiltins: false, plugins: [plugin], allowedDirectories: [] });
      const netResult = await plugin.invoke(toolId, { url: "http://example.test/x" });
      expect(netResult.ok).toBe(false);
      expect(netResult.error).toContain("EGRESS_DENIED");
      const fileResult = await plugin.invoke(toolId, { path: "C:/outside/secret.txt" });
      expect(fileResult.ok).toBe(false);
      expect(fileResult.error).toContain("FILE_CONFINEMENT_DENIED");
      agent.disposeAll();
    } finally {
      await close(plugin);
    }
  });

  test("摘要篡改被拒绝，宿主不会产生任何已安装插件", async () => {
    const base = createPluginSource("tampered", 'api.addSection("x");', { trusted: true, origin: "user" });
    let rejected = false;
    try {
      await evaluatePluginSource({ ...base, digest: `sha256:${"f".repeat(64)}` });
    } catch (error) {
      rejected = error instanceof Error && error.message.includes("PLUGIN_DIGEST_MISMATCH");
    }
    expect(rejected).toBe(true);
  });
});
