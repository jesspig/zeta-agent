export type KeyLayer = "tui" | "app" | "user";

export interface KeyComboInput {
  readonly name: string;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly meta?: boolean;
  readonly option?: boolean;
  readonly super?: boolean;
}

const MODIFIER_ORDER = ["ctrl", "shift", "meta", "option", "super"] as const;
type Modifier = (typeof MODIFIER_ORDER)[number];

/** 终端/Kitty 的常见别名归到规范修饰键，避免同一物理键注册两次。 */
const MODIFIER_ALIASES: Readonly<Record<string, Modifier>> = {
  control: "ctrl",
  ctl: "ctrl",
  alt: "meta",
  opt: "option",
  option: "option",
  cmd: "super",
  command: "super",
};

/** 按键名别名；enter/esc 与 Kitty/终端上报的差异在此收敛。 */
const KEY_ALIASES: Readonly<Record<string, string>> = {
  enter: "return",
  esc: "escape",
  del: "delete",
  spacebar: "space",
  uparrow: "up",
  downarrow: "down",
  leftarrow: "left",
  rightarrow: "right",
};

function normalizeModifierMap(input: KeyComboInput | string): {
  name: string;
  modifiers: ReadonlySet<Modifier>;
} {
  if (typeof input === "string") {
    const parts = input.split("+").map((part) => part.trim()).filter((part) => part.length > 0);
    const modifiers = new Set<Modifier>();
    let name = "";
    for (const part of parts) {
      const lower = part.toLowerCase();
      const alias = MODIFIER_ALIASES[lower];
      if (alias !== undefined) modifiers.add(alias);
      else if (MODIFIER_ORDER.includes(lower as Modifier)) modifiers.add(lower as Modifier);
      else name = lower;
    }
    return { name: KEY_ALIASES[name] ?? name, modifiers };
  }

  const modifiers = new Set<Modifier>();
  for (const [key, value] of Object.entries(input)) {
    if (key === "name" || value !== true) continue;
    const lower = key.toLowerCase();
    if (MODIFIER_ORDER.includes(lower as Modifier)) modifiers.add(lower as Modifier);
    else if (MODIFIER_ALIASES[lower] !== undefined) modifiers.add(MODIFIER_ALIASES[lower] as Modifier);
  }
  const lower = input.name.toLowerCase();
  return { name: KEY_ALIASES[lower] ?? lower, modifiers };
}

/** 修饰键与按键名的唯一规范化入口：顺序固定、别名归一、大小写不敏感。 */
export function normalizeKeyCombo(input: KeyComboInput | string): string {
  const { name, modifiers } = normalizeModifierMap(input);
  const parts: string[] = MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier));
  parts.push(name);
  return parts.join("+");
}

/** 按固定顺序拼接修饰键为规范 combo 字符串：ctrl+shift+meta+option+super+<name>。 */
export function formatKeyCombo(key: KeyComboInput): string {
  return normalizeKeyCombo(key);
}

/** Kitty/普通键盘事件 → 规范 combo，供三层注册表解析。 */
export function resolveKittyCombo(key: KeyComboInput): string {
  return normalizeKeyCombo(key);
}

export interface KeyWithComposition extends KeyComboInput {
  readonly isComposing?: boolean;
}

/** IME 组合期间忽略快捷键，避免拼音候选中的 ctrl+d/esc 被当成宿主命令（三平台一致）。 */
export function isImeCompositionKey(key: KeyWithComposition): boolean {
  return key.isComposing === true && key.name !== "process";
}

const LAYER_PRIORITY: Record<KeyLayer, number> = {
  tui: 0,
  app: 1,
  user: 2,
};

export interface KeyBinding {
  readonly combo: string;
  readonly action: string;
  readonly layer: KeyLayer;
}

export interface KeymapRegistry {
  register(binding: KeyBinding): () => void;
  resolve(combo: string): KeyBinding | undefined;
  list(): readonly KeyBinding[];
}

export class KeymapConflictError extends Error {
  readonly code = "KEYMAP_CONFLICT" as const;
  constructor(combo: string, layer: KeyLayer) {
    super(`KEYMAP_CONFLICT: ${combo} 已在 ${layer} 层注册`);
    this.name = "KeymapConflictError";
  }
}

/** IF-07 三层有序键位注册表：用户 > APP > TUI，同层同键冲突显式报错。 */
export function createKeymap(): KeymapRegistry {
  const bindings: KeyBinding[] = [];

  return {
    register(binding) {
      const combo = normalizeKeyCombo(binding.combo);
      const duplicate = bindings.some(
        (existing) => existing.combo === combo && existing.layer === binding.layer,
      );
      if (duplicate) throw new KeymapConflictError(combo, binding.layer);
      const normalized: KeyBinding = { ...binding, combo };
      bindings.push(normalized);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const index = bindings.indexOf(normalized);
        if (index >= 0) bindings.splice(index, 1);
      };
    },
    resolve(combo) {
      const canonical = normalizeKeyCombo(combo);
      return bindings
        .filter((binding) => binding.combo === canonical)
        .sort((a, b) => LAYER_PRIORITY[b.layer] - LAYER_PRIORITY[a.layer])[0];
    },
    list() {
      return [...bindings];
    },
  };
}

/** 生产 TUI 默认占用键位；用户层可覆盖，APP 层承接宿主动作。 */
export const TUI_DEFAULT_BINDINGS: readonly KeyBinding[] = Object.freeze([
  { combo: "ctrl+o", action: "toggle-tools", layer: "tui" },
  { combo: "ctrl+t", action: "toggle-thinking", layer: "tui" },
  { combo: "meta+return", action: "follow-up", layer: "tui" },
  { combo: "option+return", action: "follow-up", layer: "tui" },
  { combo: "ctrl+shift+c", action: "copy-selection", layer: "tui" },
]);

export const APP_DEFAULT_BINDINGS: readonly KeyBinding[] = Object.freeze([
  { combo: "escape", action: "abort", layer: "app" },
  { combo: "ctrl+d", action: "exit", layer: "app" },
  { combo: "ctrl+l", action: "model-selector", layer: "app" },
  { combo: "ctrl+g", action: "confirm", layer: "app" },
  { combo: "ctrl+p", action: "palette", layer: "app" },
]);

export interface RuntimeKeymapOptions {
  readonly bindings?: readonly KeyBinding[];
}

/** 生产装配入口：TUI/APP 默认键 + 宿主提供的三层自定义键，冲突显式抛出。 */
export function createRuntimeKeymap(options: RuntimeKeymapOptions = {}): KeymapRegistry {
  const keymap = createKeymap();
  for (const binding of [...TUI_DEFAULT_BINDINGS, ...APP_DEFAULT_BINDINGS, ...(options.bindings ?? [])]) {
    keymap.register(binding);
  }
  return keymap;
}

export interface ReactiveKeymap extends KeymapRegistry {
  /** 热更新宿主自定义键位；默认 TUI/APP 层始终重建，冲突同样显式抛出。 */
  setBindings(bindings: readonly KeyBinding[]): void;
}

/**
 * 响应式键位表：native 与 custom backend 共用同一实例契约。
 * setBindings 后 resolve/list 立即看到新绑定，无需重建 App 或重挂终端。
 */
export function createReactiveKeymap(options: RuntimeKeymapOptions = {}): ReactiveKeymap {
  let registry = createRuntimeKeymap(options);
  return {
    register(binding) {
      return registry.register(binding);
    },
    resolve(combo) {
      return registry.resolve(combo);
    },
    list() {
      return registry.list();
    },
    setBindings(bindings) {
      registry = createRuntimeKeymap({ bindings });
    },
  };
}
