import type { AssemblyProfile } from "./builtins";
import type { CapabilityDiagnostic, CapabilityState } from "./manifest";

/** profile 声明对应的真实后端档位；只有 local-safe 收敛，其余是可运行的 local-full。 */
export type AssemblyBackendProfile = "local-safe" | "local-full";

export interface ProfilePolicy {
  readonly profile: AssemblyProfile;
  readonly backend: AssemblyBackendProfile;
  /** 真实 shell 执行器是否启用（local-full 后端提供）。 */
  readonly shell: boolean;
  /** 默认使用持久 SessionStore，而不是内存 stub。 */
  readonly persistentSession: boolean;
  /** 按 profile 安装真实资源 coeffect/watcher。 */
  readonly resourceWatcher: boolean;
  /** 安装真实 session control 服务（跨进程控制面）。 */
  readonly sessionControl: boolean;
  readonly tenantMode: "single-tenant" | "multi-tenant";
  /** research 轨只声明入口；seal 仍由 T-21/RED-04 负责，禁止伪装 active。 */
  readonly research: boolean;
  readonly reason: string;
}

function policy(
  profile: AssemblyProfile,
  values: Omit<ProfilePolicy, "profile" | "reason"> & { reason?: string }
): ProfilePolicy {
  const backend = values.backend;
  return {
    profile,
    ...values,
    reason:
      values.reason ??
      `${profile}: backend=${backend}, shell=${values.shell ? "active" : "disabled"}, session=${values.persistentSession ? "persistent" : "memory"}, watcher=${values.resourceWatcher ? "installed" : "not-installed"}`,
  };
}

/** 单一真源：manifest、runtime 装配与能力诊断都读取此表。 */
export const PROFILE_POLICY: Readonly<Record<AssemblyProfile, ProfilePolicy>> = Object.freeze({
  "local-safe": policy("local-safe", {
    backend: "local-safe",
    shell: false,
    persistentSession: false,
    resourceWatcher: false,
    sessionControl: false,
    tenantMode: "single-tenant",
    research: false,
  }),
  "local-full": policy("local-full", {
    backend: "local-full",
    shell: true,
    persistentSession: true,
    resourceWatcher: true,
    sessionControl: false,
    tenantMode: "single-tenant",
    research: false,
  }),
  daemon: policy("daemon", {
    backend: "local-full",
    shell: true,
    persistentSession: true,
    resourceWatcher: true,
    sessionControl: true,
    tenantMode: "single-tenant",
    research: false,
  }),
  remote: policy("remote", {
    backend: "local-full",
    shell: true,
    persistentSession: true,
    resourceWatcher: true,
    sessionControl: true,
    tenantMode: "single-tenant",
    research: false,
  }),
  research: policy("research", {
    backend: "local-full",
    shell: true,
    persistentSession: true,
    resourceWatcher: true,
    sessionControl: false,
    tenantMode: "single-tenant",
    research: true,
    reason: "research: 真实 shell/资源/持久会话已装配；research seal 属 T-21/RED-04，未接入前不声明 active",
  }),
  "multi-tenant": policy("multi-tenant", {
    backend: "local-full",
    shell: true,
    persistentSession: true,
    resourceWatcher: true,
    sessionControl: true,
    tenantMode: "multi-tenant",
    research: false,
  }),
});

export function policyForProfile(profile: AssemblyProfile): ProfilePolicy {
  const found = PROFILE_POLICY[profile];
  if (found === undefined) throw new Error(`INVALID_PROFILE: ${profile}`);
  return found;
}

/** profile 自身的声明进入同一份诊断；research seal 明确 unsupported，不借 profile 冒充。 */
export function diagnoseProfilePolicy(profile: AssemblyProfile): readonly CapabilityDiagnostic[] {
  const current = policyForProfile(profile);
  const state: CapabilityState = "active";
  const diagnostics: CapabilityDiagnostic[] = [
    { id: `profile:${profile}`, state, reason: current.reason },
  ];
  if (current.research) {
    diagnostics.push({
      id: "research:seal",
      state: "unsupported",
      reason: "research seal 属 T-21/RED-04；T-20 不实现也不伪装 active",
    });
  }
  return diagnostics;
}
