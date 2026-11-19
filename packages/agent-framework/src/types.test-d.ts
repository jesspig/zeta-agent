import type { AgentPluginApi, Capabilities, RedactRule } from "./types";

declare const api: AgentPluginApi;

const capabilities: Capabilities = api.capabilities();
const active: boolean = capabilities.isolation === "active";

const stopEffect: () => void = api.onEffect((meta) => {
  const label: string = meta.label;
  void label;
});

const redactRule: RedactRule = { match: /secret/g, replace: "[REDACTED]" };
const stopRedactor: () => void = api.addRedactor(redactRule);

export type { active, stopEffect, stopRedactor, capabilities };
