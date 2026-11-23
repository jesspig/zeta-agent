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
  // 关键层只有 active 才代表强制已生效；degraded/unsupported/disabled 都必须失败关闭。
  return CRITICAL_LAYERS.filter((layer) => capabilities[layer] !== "active");
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

/**
 * 未接入真实执行器时的占位能力：所有层都声明 unsupported。
 * 关键层只有 active 才算强制生效，因此能力探测会立刻判定为降级并失败关闭。
 */
export const UNCONNECTED_CAPABILITIES: Capabilities = Object.freeze({
  isolation: "unsupported",
  seccomp: "unsupported",
  fsConfinement: "unsupported",
  auditSink: "unsupported",
  egressDefaultDeny: "unsupported",
});

export interface UnconnectedBackendOptions {
  readonly name?: string;
  readonly reason?: string;
}

/**
 * 占位后端：没有真实隔离执行器时，能力声明必须与实际一致（unsupported），
 * 不能假装 active 再把命令报告为成功。run 在能力探测阶段即失败关闭。
 */
export function createUnconnectedBackend(options: UnconnectedBackendOptions = {}): ExecutionBackend {
  const reason = options.reason ?? "NO_REAL_EXECUTION_BACKEND: 未配置真实隔离执行后端";
  return createExecutionBackend({
    name: options.name ?? "unconnected-placeholder",
    capabilities: UNCONNECTED_CAPABILITIES,
    executor: () => ({ exitCode: 1, stdout: "", stderr: reason, isolated: null }),
  });
}
