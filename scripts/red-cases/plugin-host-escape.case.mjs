import {
  createPluginSource,
  evaluatePluginSource,
} from "../../packages/agent-framework/src/plugins/isolated-evaluator.ts";
import { createAgent } from "../../packages/agent/src/facade.ts";
import { green, red } from "./common.mjs";

const SOURCE = `
globalThis.__RED09_TOPLEVEL = true;
globalThis.__RED09_PROCESS = typeof globalThis.process;
globalThis.__RED09_FETCH = typeof globalThis.fetch;
api.addSection("RED09 SECTION");
api.on("agent_start", function () {
  globalThis.__RED09_HOOK = true;
});
api.onInstall(function () {
  globalThis.__RED09_INSTALL = true;
});
`;

const KEYS = [
  "__RED09_TOPLEVEL",
  "__RED09_PROCESS",
  "__RED09_FETCH",
  "__RED09_HOOK",
  "__RED09_INSTALL",
];

const EVIDENCE =
  "packages/agent-framework/src/plugins/types.ts（defineCompatExtension 宿主直调 builder）/ " +
  "packages/agent/src/facade.ts:1445-1467（install 宿主调用；untrusted hook 仍进宿主链）";

export default {
  id: "RED-09-plugin-host-escape",
  title: "不可信插件必须在子进程求值：顶层代码/install/hook 不得在宿主执行",
  expectation:
    "untrusted PluginSource 的顶层代码只在子进程求值（宿主 process/fetch 不可达）；宿主不调用 install()，hook 不进宿主链；仅 section 等数据型贡献可见",
  target: "AC-13",
  async probe() {
    for (const key of KEYS) delete globalThis[key];
    let actual = {};
    try {
      const source = createPluginSource("red09", SOURCE, {
        trusted: false,
        origin: "remote",
        capabilities: ["prompt:section", "events:on"],
      });
      const plugin = await evaluatePluginSource(source);
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
      actual = Object.fromEntries(KEYS.map((key) => [key, globalThis[key]]));
      const sections = agent.pluginSections.map((item) => item.text);
      actual.sections = sections;
      const escaped =
        actual.__RED09_TOPLEVEL === true ||
        actual.__RED09_PROCESS === "object" ||
        actual.__RED09_FETCH === "function" ||
        actual.__RED09_HOOK === true ||
        actual.__RED09_INSTALL === true;
      const sectionPreserved = sections.includes("RED09 SECTION");
      agent.disposeAll();
      return escaped || !sectionPreserved
        ? red(
            actual,
            escaped
              ? "不可信插件仍在宿主执行：顶层副作用或宿主 process/fetch/install/hook 被触达"
              : "隔离后数据型 section 贡献也丢失（伪装成功/能力报告失真）",
            EVIDENCE
          )
        : green(actual, "packages/agent-framework/src/plugins/isolated-evaluator.ts + facade 信任收口");
    } catch (error) {
      actual.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      return red(actual, "隔离求值链路异常，未能给出可信的阻断证据", EVIDENCE);
    } finally {
      for (const key of KEYS) delete globalThis[key];
    }
  },
};
