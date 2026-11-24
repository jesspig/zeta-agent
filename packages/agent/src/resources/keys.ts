import { defineKey, type CoeffectKey } from "@zeta-agent/framework";
import type { ResourceEntry, ResourceType } from "./registry";

const SKILLS_KEY_NAME = "@zeta-agent/skills:registry";
const PROMPTS_KEY_NAME = "@zeta-agent/prompts:registry";
const THEMES_KEY_NAME = "@zeta-agent/themes:registry";
const AGENTS_KEY_NAME = "@zeta-agent/agents:registry";

export const skillsRegistryKey = defineKey<readonly ResourceEntry[]>(SKILLS_KEY_NAME);
export const promptsRegistryKey = defineKey<readonly ResourceEntry[]>(PROMPTS_KEY_NAME);
export const themesRegistryKey = defineKey<readonly ResourceEntry[]>(THEMES_KEY_NAME);
export const agentsRegistryKey = defineKey<readonly ResourceEntry[]>(AGENTS_KEY_NAME);

export const RESOURCE_KEYS: Readonly<Record<ResourceType, CoeffectKey<readonly ResourceEntry[]>>> = Object.freeze({
  skill: skillsRegistryKey,
  prompt: promptsRegistryKey,
  theme: themesRegistryKey,
  agents: agentsRegistryKey,
});

export const RESOURCE_KEY_LIST: readonly CoeffectKey<readonly ResourceEntry[]>[] = Object.freeze([
  skillsRegistryKey,
  promptsRegistryKey,
  themesRegistryKey,
  agentsRegistryKey,
]);

export function resourceKeyFor(type: ResourceType): CoeffectKey<readonly ResourceEntry[]> {
  return RESOURCE_KEYS[type];
}
