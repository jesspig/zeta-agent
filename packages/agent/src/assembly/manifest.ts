import { type ResourceType } from "../resources/registry";
import {
  builtinsForProfile,
  resolveAssemblyProfile,
  type AssemblyProfile,
} from "./builtins";

/** 能力四态，与 security 的 LayerState 对齐但增加 disabled（明确禁用）。 */
export type CapabilityState = "active" | "degraded" | "unsupported" | "disabled";

export interface CapabilityDiagnostic {
  readonly id: string;
  readonly state: CapabilityState;
  readonly reason: string;
}

/** 安装注册表中真实发现的一条资源（由 ResourceRegistry.discover 投影而来）。 */
export interface InstalledResource {
  readonly id: string;
  readonly type: ResourceType;
  readonly scope: "agent" | "project";
  readonly relativePath: string;
}

export interface AssemblyManifest {
  readonly profile: AssemblyProfile;
  /** 已安装 builtin 的 id（工具 + 服务 + 会话 + 模式）。 */
  readonly plugins: readonly string[];
  readonly tools: readonly string[];
  readonly services: readonly string[];
  readonly session: readonly string[];
  readonly modes: readonly string[];
  /** 仅来自安装注册表的真实资源；不手写 skills/session。 */
  readonly resources: readonly InstalledResource[];
  readonly diagnostics: readonly CapabilityDiagnostic[];
  readonly generation: number;
}

export interface AssemblyManifestOptions {
  readonly profile?: string | AssemblyProfile;
  readonly resources?: readonly InstalledResource[];
  readonly diagnostics?: readonly CapabilityDiagnostic[];
  readonly generation?: number;
}

/**
 * 从安装注册表（BUILTIN_PLUGINS + 资源发现结果）生成 manifest。
 * CLI 与 SDK 必须调用同一函数，避免两处手写清单漂移。
 */
export function createAssemblyManifest(options: AssemblyManifestOptions = {}): AssemblyManifest {
  const profile = resolveAssemblyProfile(options.profile);
  const plugins = builtinsForProfile(profile);
  const pick = (kind: "tool" | "service" | "session" | "mode"): readonly string[] =>
    plugins.filter((plugin) => plugin.kind === kind).map((plugin) => plugin.name);
  const ids = plugins.map((plugin) => plugin.id);

  return {
    profile,
    plugins: ids,
    tools: pick("tool"),
    services: pick("service"),
    session: pick("session"),
    modes: pick("mode"),
    resources: [...(options.resources ?? [])],
    diagnostics: [...(options.diagnostics ?? [])],
    generation: options.generation ?? 1,
  };
}
