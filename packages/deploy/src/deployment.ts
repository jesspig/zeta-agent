import type { Disposer } from "@zeta-agent/framework";
import { computeConfigDigest } from "./canonical";
import { assertTarget } from "./targets";
import type { RuntimeProbeSource } from "./runtime-probes";

export { computeConfigDigest } from "./canonical";

export type DeployMode = "local" | "daemon" | "remote";

export interface DeployConfig {
  readonly target: string;
  readonly [key: string]: unknown;
}

export interface StartOptions {
  /** 提供后探针直接读取真实 AgentRuntime，不再使用本地占位状态。 */
  readonly runtime?: RuntimeProbeSource;
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

export function start(mode: DeployMode, config: DeployConfig, options: StartOptions = {}): DeployHandle {
  if (mode !== "local" && mode !== "daemon" && mode !== "remote") {
    throw new Error(`INVALID_DEPLOY_MODE: ${mode}`);
  }
  assertTarget(config.target);
  const runtime = options.runtime;
  if (runtime !== undefined && runtime.target !== config.target) {
    throw new Error(`RUNTIME_TARGET_MISMATCH: ${runtime.target} != ${config.target}`);
  }

  let current: DeployConfig = { ...config };
  let ready = mode === "local";
  let alive = true;

  return {
    mode,
    readiness: () => ready && alive && (runtime?.readiness() ?? true),
    liveness: () => alive && (runtime?.liveness() ?? true),
    configDigest: () =>
      runtime === undefined
        ? computeConfigDigest(current)
        : computeConfigDigest({ deploy: current, runtime: runtime.configDigest() }),
    setReadiness(next) {
      ready = next === true;
    },
    updateConfig(next) {
      assertTarget(next.target);
      if (runtime !== undefined && runtime.target !== next.target) {
        throw new Error(`RUNTIME_TARGET_MISMATCH: ${runtime.target} != ${next.target}`);
      }
      current = { ...next };
    },
    stop: () => {
      alive = false;
      ready = false;
    },
  };
}
