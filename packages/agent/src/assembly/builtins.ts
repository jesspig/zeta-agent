/**
 * T-10 真实内建插件注册表。
 *
 * 这里只登记代码中确实存在的 builtin（工具 / 服务 / 会话 / 模式）。
 * 清单是 manifest 的唯一来源，facade 的 DEFAULT_ASSEMBLY 与 CLI 的装配都从它派生，
 * 不再手写不存在的 skills/session 或研究轨 seam。
 */

export type AssemblyProfile = "local-safe" | "local-full";

export const ASSEMBLY_PROFILES: readonly AssemblyProfile[] = Object.freeze([
  "local-safe",
  "local-full",
]);

export type BuiltinKind = "tool" | "service" | "session" | "mode";

export interface BuiltinPlugin {
  /** 稳定装配 id；与 manifest/facade 清单一致。 */
  readonly id: string;
  readonly kind: BuiltinKind;
  /** 运行时名字：工具名 / 服务名 / 模式名。 */
  readonly name: string;
  /** 哪些产品 profile 会安装该 builtin。 */
  readonly profiles: readonly AssemblyProfile[];
}

const BOTH: readonly AssemblyProfile[] = Object.freeze(["local-safe", "local-full"]);
const FULL: readonly AssemblyProfile[] = Object.freeze(["local-full"]);

/** 真实存在的 builtin 集合；顺序即默认装配顺序。 */
export const BUILTIN_PLUGINS: readonly BuiltinPlugin[] = Object.freeze([
  // 工具：对应 builtinToolDefinitions 的实际实现。
  { id: "builtin:read", kind: "tool", name: "read", profiles: BOTH },
  { id: "builtin:bash", kind: "tool", name: "bash", profiles: BOTH },
  { id: "builtin:powershell", kind: "tool", name: "powershell", profiles: BOTH },
  { id: "builtin:write", kind: "tool", name: "write", profiles: BOTH },
  { id: "builtin:edit", kind: "tool", name: "edit", profiles: BOTH },
  { id: "builtin:ls", kind: "tool", name: "ls", profiles: BOTH },
  { id: "builtin:grep", kind: "tool", name: "grep", profiles: BOTH },
  { id: "builtin:find", kind: "tool", name: "find", profiles: BOTH },
  // 服务：由 createResourceRegistry / session tree 提供真实实现。
  { id: "skills:registry", kind: "service", name: "skills:registry", profiles: BOTH },
  { id: "service:prompts:registry", kind: "service", name: "prompts:registry", profiles: FULL },
  { id: "service:themes:registry", kind: "service", name: "themes:registry", profiles: FULL },
  // 会话：JSONL tree 实现的内存投影。
  { id: "session:store", kind: "session", name: "session:store", profiles: BOTH },
  // 模式：MODES 注册表，四种形态共享 session/control/event 协议。
  { id: "mode:interactive", kind: "mode", name: "interactive", profiles: BOTH },
  { id: "mode:print", kind: "mode", name: "print", profiles: BOTH },
  { id: "mode:json", kind: "mode", name: "json", profiles: BOTH },
  { id: "mode:rpc", kind: "mode", name: "rpc", profiles: BOTH },
]);

/** 解析 profile；未知值失败关闭，绝不静默回退成更宽松的档位后继续运行。 */
export function resolveAssemblyProfile(
  value: string | undefined,
  fallback: AssemblyProfile = "local-safe"
): AssemblyProfile {
  if (value === undefined || value.length === 0) return fallback;
  if ((ASSEMBLY_PROFILES as readonly string[]).includes(value)) return value as AssemblyProfile;
  throw new Error(`INVALID_PROFILE: ${value}`);
}

/** 指定 profile 实际安装的 builtin。 */
export function builtinsForProfile(profile: AssemblyProfile): readonly BuiltinPlugin[] {
  return BUILTIN_PLUGINS.filter((plugin) => plugin.profiles.includes(profile));
}

/** 从注册表派生装配 id 列表——facade 清单与 manifest 共用同一来源。 */
export function builtinIdsForProfile(profile: AssemblyProfile = "local-safe"): readonly string[] {
  return builtinsForProfile(profile).map((plugin) => plugin.id);
}
