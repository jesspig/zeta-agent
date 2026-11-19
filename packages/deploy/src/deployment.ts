import type { Disposer } from "@zeta-agent/framework";
import { assertTarget } from "./targets";

export type DeployMode = "local" | "daemon" | "remote";

export interface DeployConfig {
  readonly target: string;
  readonly [key: string]: unknown;
}

export interface DeployHandle {
  readonly mode: DeployMode;
  readiness(): boolean;
  liveness(): boolean;
  configDigest(): string;
  setReadiness(ready: boolean): void;
  updateConfig(next: DeployConfig): void;
  readonly stop: Disposer;
}

function stableStringify(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

export function computeConfigDigest(config: Readonly<Record<string, unknown>>): string {
  const text = stableStringify(config);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function start(mode: DeployMode, config: DeployConfig): DeployHandle {
  if (mode !== "local" && mode !== "daemon" && mode !== "remote") {
    throw new Error(`INVALID_DEPLOY_MODE: ${mode}`);
  }
  assertTarget(config.target);

  let current: DeployConfig = { ...config };
  let ready = mode === "local";
  let alive = true;

  return {
    mode,
    readiness: () => ready && alive,
    liveness: () => alive,
    configDigest: () => computeConfigDigest(current),
    setReadiness(next) {
      ready = next === true;
    },
    updateConfig(next) {
      assertTarget(next.target);
      current = { ...next };
    },
    stop: () => {
      alive = false;
      ready = false;
    },
  };
}
