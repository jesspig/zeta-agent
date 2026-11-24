import { computeConfigDigest } from "./canonical";
import { hostTarget } from "./build-plan";

/** AgentRuntime 的最小稳定 seam：只读取真实装配的生命周期与身份，不重建执行路径。 */
export interface AgentRuntimeLike {
  readonly target?: string;
  readonly rootFiber: { readonly state: { readonly kind: string } };
  readonly profile: string;
  readonly manifest: unknown;
  readonly protocol?: { readonly session?: { readonly id?: string } };
}

export interface RuntimeProbeSource {
  readonly target: string;
  readiness(): boolean;
  liveness(): boolean;
  configDigest(): string;
}

export function createRuntimeProbeSource(runtime: AgentRuntimeLike): RuntimeProbeSource {
  const target = runtime.target ?? hostTarget() ?? "linux-x64";
  const state = () => runtime.rootFiber.state.kind;
  return {
    target,
    readiness: () => state() === "ACTIVE",
    liveness: () => {
      const kind = state();
      return kind !== "DISPOSED" && kind !== "FAILED";
    },
    configDigest: () =>
      computeConfigDigest({
        profile: runtime.profile,
        manifest: runtime.manifest,
        session: runtime.protocol?.session?.id,
      }),
  };
}
