import type { Disposer } from "@zeta-agent/framework";

export type LayerState = "active" | "degraded" | "unsupported" | "disabled";

export interface Capabilities {
  isolation: LayerState;
  seccomp: LayerState;
  fsConfinement: LayerState;
  auditSink: LayerState;
  egressDefaultDeny: LayerState;
}

export interface Command {
  readonly argv: readonly string[];
}

export interface RunOptions {
  readonly realm?: string;
}

export interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly isolated: string | null;
}

export interface ExecutionBackend {
  readonly name: string;
  capabilities(): Capabilities;
  run(command: Command, options?: RunOptions): Promise<RunResult>;
  readonly dispose: Disposer;
}

export interface BackendConfig {
  readonly name: string;
  readonly capabilities: Capabilities;
  readonly executor: (command: Command, options?: RunOptions) => RunResult | Promise<RunResult>;
}

export const CRITICAL_LAYERS = ["isolation", "seccomp", "fsConfinement"] as const;

export type CapabilityKey = keyof Capabilities;

export function criticalLayerFailures(capabilities: Capabilities): CapabilityKey[] {
  return CRITICAL_LAYERS.filter(
    (layer) => capabilities[layer] === "degraded" || capabilities[layer] === "unsupported"
  );
}

export function isCriticalLayerDegraded(capabilities: Capabilities): boolean {
  return criticalLayerFailures(capabilities).length > 0;
}

export function assertEnforcement(capabilities: Capabilities): void {
  const failures = criticalLayerFailures(capabilities);
  if (failures.length > 0) throw new Error(`CRITICAL_LAYER_DEGRADED: ${failures.join(",")}`);
}

export function createExecutionBackend(config: BackendConfig): ExecutionBackend {
  return {
    name: config.name,
    capabilities: () => ({ ...config.capabilities }),
    async run(command: Command, options?: RunOptions): Promise<RunResult> {
      assertEnforcement(config.capabilities);
      return config.executor(command, options);
    },
    dispose: () => {},
  };
}
