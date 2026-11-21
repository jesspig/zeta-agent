export type KeyLayer = "tui" | "app" | "user";

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
