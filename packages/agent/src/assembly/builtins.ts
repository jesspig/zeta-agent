/**
 * T-10 真实内建插件注册表 / T-20 六 profile 声明。
 *
 * 这里只登记代码中确实存在的 builtin（工具 / 服务 / 会话 / 模式）。
 * 清单是 manifest 的唯一来源，facade 的 DEFAULT_ASSEMBLY 与 CLI 的装配都从它派生，
 * 不再手写不存在的 skills/session 或研究轨 seam。
 *
 * T-20：profile 声明与 enforcement 由同一来源派生，禁止 manifest 与实际装配两套房。
 */

export type AssemblyProfile =
  | "local-safe"
  | "local-full"
  | "daemon"
  | "remote"
  | "research"
  | "multi-tenant";

export const ASSEMBLY_PROFILES: readonly AssemblyProfile[] = Object.freeze([
  "local-safe",
  "local-full",
  "daemon",
  "remote",
  "research",
  "multi-tenant",
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

const ALL: readonly AssemblyProfile[] = Object.freeze([...ASSEMBLY_PROFILES]);
/** local-safe 收敛：不安装全量 service；其余档位完整暴露。 */
const FULL: readonly AssemblyProfile[] = Object.freeze(
  ASSEMBLY_PROFILES.filter((profile) => profile !== "local-safe")
);
/** 跨进程/租户控制面真实需要的服务。 */
const CONTROL: readonly AssemblyProfile[] = Object.freeze(["daemon", "remote", "multi-tenant"]);

/** 真实存在的 builtin 集合；顺序即默认装配顺序。 */
export const BUILTIN_PLUGINS: readonly BuiltinPlugin[] = Object.freeze([
  // 工具：对应 builtinToolDefinitions 的实际实现。可见性由能力诊断收敛。
  { id: "builtin:read", kind: "tool", name: "read", profiles: ALL },
  { id: "builtin:bash", kind: "tool", name: "bash", profiles: ALL },
  { id: "builtin:powershell", kind: "tool", name: "powershell", profiles: ALL },
  { id: "builtin:write", kind: "tool", name: "write", profiles: ALL },
  { id: "builtin:edit", kind: "tool", name: "edit", profiles: ALL },
  { id: "builtin:ls", kind: "tool", name: "ls", profiles: ALL },
  { id: "builtin:grep", kind: "tool", name: "grep", profiles: ALL },
  { id: "builtin:find", kind: "tool", name: "find", profiles: ALL },
  // 服务：由 createResourceRegistry / session tree / resource watcher 提供真实实现。
  { id: "skills:registry", kind: "service", name: "skills:registry", profiles: ALL },
  { id: "service:prompts:registry", kind: "service", name: "prompts:registry", profiles: FULL },
  { id: "service:themes:registry", kind: "service", name: "themes:registry", profiles: FULL },
  { id: "service:resources:watcher", kind: "service", name: "resources:watcher", profiles: FULL },
  { id: "service:session:control", kind: "service", name: "session:control", profiles: CONTROL },
  // 会话：JSONL tree 实现的内存投影。
  { id: "session:store", kind: "session", name: "session:store", profiles: ALL },
  // 模式：MODES 注册表，四种形态共享 session/control/event 协议。
  { id: "mode:interactive", kind: "mode", name: "interactive", profiles: ALL },
  { id: "mode:print", kind: "mode", name: "print", profiles: ALL },
  { id: "mode:json", kind: "mode", name: "json", profiles: ALL },
  { id: "mode:rpc", kind: "mode", name: "rpc", profiles: ALL },
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
  if (!(ASSEMBLY_PROFILES as readonly string[]).includes(profile)) {
    throw new Error(`INVALID_PROFILE: ${profile}`);
  }
  return BUILTIN_PLUGINS.filter((plugin) => plugin.profiles.includes(profile));
}

/** 从注册表派生装配 id 列表——facade 清单与 manifest 共用同一来源。 */
export function builtinIdsForProfile(profile: AssemblyProfile = "local-safe"): readonly string[] {
  return builtinsForProfile(profile).map((plugin) => plugin.id);
}
