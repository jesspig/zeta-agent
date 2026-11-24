import { identityDisposer, type Disposer } from "@zeta-agent/framework";

/** 核心 root：loader/HMR/fiber 核心/capability gate，绝不许普通插件同名替换。 */
export const REQUIRED_ROOTS: readonly string[] = Object.freeze([
  "loader",
  "hmr",
  "fiber-core",
  "capability-gate",
]);

export const DEFAULT_PLUGIN_REALM: symbol = Symbol.for("zeta:plugins:realm:default");

export interface PluginSlot<T> {
  readonly name: string;
  readonly value: T;
  readonly realm: symbol;
  readonly order: number;
  readonly replaceable: boolean;
  readonly required: boolean;
  readonly source: string | undefined;
  readonly seq: number;
  /** 身份令牌：disposer 只删除自己注册的那一条，不误伤后来的同名条目。 */
  readonly token: object;
}

export interface PluginSlotInput<T> {
  readonly name: string;
  readonly value: T;
  readonly realm?: symbol;
  readonly order?: number;
  readonly replaceable?: boolean;
  readonly required?: boolean;
  readonly source?: string;
}

export interface PluginRegistry<T> {
  /** 注册并返回身份 disposer；required/replaceable 冲突时抛错，不写入。 */
  register(input: PluginSlotInput<T>): Disposer;
  resolve(name: string, realm?: symbol): T | undefined;
  snapshot(realm?: symbol): readonly PluginSlot<T>[];
  readonly generation: number;
}

export interface PluginRegistryOptions {
  readonly defaultRealm?: symbol;
  readonly requiredNames?: readonly string[];
}

/**
 * 真实注册入口：按 name + realm 分槽，order 决定快照顺序，
 * required root 与不可替换条目拒绝覆盖，同名可替换条目由身份 disposer 精确撤销。
 */
export function createPluginRegistry<T>(options: PluginRegistryOptions = {}): PluginRegistry<T> {
  const defaultRealm = options.defaultRealm ?? DEFAULT_PLUGIN_REALM;
  const requiredNames = new Set(options.requiredNames ?? REQUIRED_ROOTS);
  const realms = new Map<symbol, Map<string, PluginSlot<T>>>();
  let sequence = 0;
  let generation = 0;

  function bucket(realm: symbol): Map<string, PluginSlot<T>> {
    let entries = realms.get(realm);
    if (entries === undefined) {
      entries = new Map<string, PluginSlot<T>>();
      realms.set(realm, entries);
    }
    return entries;
  }

  return {
    register(input) {
      const realm = input.realm ?? defaultRealm;
      const required = input.required === true || requiredNames.has(input.name);
      const entries = bucket(realm);
      const existing = entries.get(input.name);
      // required root 只能由宿主自身的 builtin 声明；第三方同名注册直接拒绝。
      if (requiredNames.has(input.name) && input.source !== "builtin" && input.required !== true) {
        throw new Error(`REQUIRED_ROOT_REPLACED: ${input.name}`);
      }
      if (existing !== undefined && (existing.required || required)) {
        throw new Error(`REQUIRED_ROOT_REPLACED: ${input.name}`);
      }
      if (existing !== undefined && !existing.replaceable) {
        throw new Error(`REPLACE_REJECTED: ${input.name}`);
      }
      const slot: PluginSlot<T> = {
        name: input.name,
        value: input.value,
        realm,
        order: input.order ?? 100,
        replaceable: input.replaceable ?? true,
        required,
        source: input.source,
        seq: sequence++,
        token: {},
      };
      generation += 1;
      entries.set(input.name, slot);
      return identityDisposer(entries, input.name, slot);
    },
    resolve(name, realm) {
      return (realms.get(realm ?? defaultRealm)?.get(name))?.value;
    },
    snapshot(realm) {
      const slots = realm === undefined
        ? [...realms.values()].flatMap((entries) => [...entries.values()])
        : [...(realms.get(realm)?.values() ?? [])];
      return slots.slice().sort((left, right) => left.order - right.order || left.seq - right.seq);
    },
    get generation() {
      return generation;
    },
  };
}
