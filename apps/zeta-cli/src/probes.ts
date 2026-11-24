import {
  createRuntimeProbeSource,
  hostTarget,
  start,
  type AgentRuntimeLike,
  type DeployConfig,
  type DeployHandle,
} from "@zeta-agent/deploy";

export const PROBE_NAMES = ["readiness", "liveness", "configDigest"] as const;
export type ProbeName = (typeof PROBE_NAMES)[number];

export function createProbeHandle(
  runtime: AgentRuntimeLike,
  config: DeployConfig = { target: hostTarget() ?? "linux-x64" }
): DeployHandle {
  return start("local", config, { runtime: createRuntimeProbeSource(runtime) });
}

/** RPC 探针帧与 T-10 的 control 协议并列，互不冒充对方结果。 */
export function handleProbeFrame(handle: DeployHandle, line: string): string | undefined {
  let frame: unknown;
  try {
    frame = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof frame !== "object" || frame === null) return undefined;
  const record = frame as Record<string, unknown>;
  if (record.type !== "probe" || typeof record.probe !== "string") return undefined;

  const probe = record.probe;
  if (!(PROBE_NAMES as readonly string[]).includes(probe)) {
    return JSON.stringify({ type: "probe.result", probe, error: "UNKNOWN_PROBE" });
  }
  const value =
    probe === "readiness" ? handle.readiness() : probe === "liveness" ? handle.liveness() : handle.configDigest();
  return JSON.stringify({ type: "probe.result", probe, value });
}
