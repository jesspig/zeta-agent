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

/** 按固定顺序拼接修饰键为规范 combo 字符串：ctrl+shift+meta+option+super+<name>。 */
export function formatKeyCombo(key: KeyComboInput): string {
  const parts: string[] = [];
  for (const modifier of MODIFIER_ORDER) {
    if (key[modifier]) parts.push(modifier);
  }
  parts.push(key.name);
  return parts.join("+");
}

/** Kitty/普通键盘事件 → 规范 combo，供三层注册表解析。 */
export function resolveKittyCombo(key: KeyComboInput): string {
  return formatKeyCombo(key);
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
      const duplicate = bindings.some(
        (existing) => existing.combo === binding.combo && existing.layer === binding.layer,
      );
      if (duplicate) throw new KeymapConflictError(binding.combo, binding.layer);
      bindings.push(binding);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const index = bindings.indexOf(binding);
        if (index >= 0) bindings.splice(index, 1);
      };
    },
    resolve(combo) {
      return bindings
        .filter((binding) => binding.combo === combo)
        .sort((a, b) => LAYER_PRIORITY[b.layer] - LAYER_PRIORITY[a.layer])[0];
    },
    list() {
      return [...bindings];
    },
  };
}
