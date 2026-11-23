import type { Disposer } from "@zeta-agent/framework";
import type { AgentEvent } from "../runtime/agent";

export interface PluginTool<P = never> {
  readonly name: string;
  readonly execute: (input: P) => unknown;
}

export type PluginContribution =
  | { readonly kind: "tool"; readonly tool: PluginTool }
  | { readonly kind: "hook"; readonly event: string; readonly handler: (event: AgentEvent) => void }
  | { readonly kind: "section"; readonly text: string }
  | { readonly kind: "wrap"; readonly name: string }
  | { readonly kind: "task"; readonly name: string }
  | { readonly kind: "service"; readonly name: string };

export interface AgentPlugin {
  readonly kind: "AgentPlugin";
  readonly name: string;
  readonly version?: string;
  readonly contributions: readonly PluginContribution[];
  install(): Disposer;
}

/** 运行时品牌：让 `AgentPlugin` 既是类型也可被动态导入检查（接口在运行时被擦除）。 */
export const AgentPlugin = {
  kind: "AgentPlugin" as const,
  is(value: unknown): value is AgentPlugin {
    if (typeof value !== "object" || value === null) return false;
    const candidate = value as {
      kind?: unknown;
      name?: unknown;
      contributions?: unknown;
      install?: unknown;
    };
    return candidate.kind === "AgentPlugin"
      && typeof candidate.name === "string"
      && Array.isArray(candidate.contributions)
      && typeof candidate.install === "function";
  },
  define(name: string, contributions: readonly PluginContribution[]): AgentPlugin {
    return defineAgentPlugin(name, contributions);
  },
};

export interface CompatExtensionApi {
  registerTool<P>(tool: PluginTool<P>): void;
  on(event: string, handler: (event: AgentEvent) => void): void;
  addSection(text: string): void;
}

export interface DurableExtensionSpec {
  readonly tools?: readonly PluginTool[];
  readonly hooks?: readonly { readonly event: string; readonly handler: (event: AgentEvent) => void }[];
  readonly sections?: readonly string[];
  readonly wraps?: readonly string[];
  readonly tasks?: readonly string[];
}

export function defineAgentPlugin(name: string, contributions: readonly PluginContribution[]): AgentPlugin {
  if (typeof name !== "string" || name.length === 0) throw new Error("plugin: name required");
  const normalized = Object.freeze([...contributions]);
  let installed = false;
  return {
    kind: "AgentPlugin",
    name,
    contributions: normalized,
    install() {
      if (installed) throw new Error("PLUGIN_ALREADY_INSTALLED");
      installed = true;
      return () => {
        installed = false;
      };
    },
  };
}

export function defineCompatExtension(
  name: string,
  define: (api: CompatExtensionApi) => void
): AgentPlugin {
  if (typeof define !== "function") throw new Error("compat extension: expected a builder");
  const contributions: PluginContribution[] = [];
  const api: CompatExtensionApi = {
    registerTool(tool) {
      contributions.push({ kind: "tool", tool });
    },
    on(event, handler) {
      contributions.push({ kind: "hook", event, handler });
    },
    addSection(text) {
      contributions.push({ kind: "section", text });
    },
  };
  define(api);
  return defineAgentPlugin(name, contributions);
}

export function defineDurableExtension(name: string, spec: DurableExtensionSpec): AgentPlugin {
  if (spec === null || typeof spec !== "object") {
    throw new Error("durable extension: expected a spec");
  }
  const contributions: PluginContribution[] = [];
  for (const tool of spec.tools ?? []) contributions.push({ kind: "tool", tool });
  for (const hook of spec.hooks ?? []) {
    contributions.push({ kind: "hook", event: hook.event, handler: hook.handler });
  }
  for (const text of spec.sections ?? []) contributions.push({ kind: "section", text });
  for (const entry of spec.wraps ?? []) contributions.push({ kind: "wrap", name: entry });
  for (const entry of spec.tasks ?? []) contributions.push({ kind: "task", name: entry });
  return defineAgentPlugin(name, contributions);
}
