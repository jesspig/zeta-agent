import { createSlotRegistry, type SlotRegistry, type ZetaSlots } from "./slots";

/** 一个声明式槽位插件：id + 槽位名到文本内容的映射。 */
export interface SlotPlugin {
  readonly id: string;
  readonly slots: Readonly<Record<string, string>>;
}

export interface ApplyResult {
  readonly ok: boolean;
  readonly activeIds: readonly string[];
  readonly error?: unknown;
}

export interface HotSlotHost {
  /** 一次性安装整组插件；任何错误都回滚到上一组（closure rule）。 */
  apply(plugins: readonly SlotPlugin[]): ApplyResult;
  /** 渲染当前生效的槽位。 */
  render(slot: keyof ZetaSlots): string;
  /** 当前生效的插件 id 列表。 */
  current(): readonly string[];
}

function isSlotName(value: string): value is keyof ZetaSlots {
  return [
    "header",
    "footer",
    "message",
    "tool",
    "editor",
    "overlay",
    "hud",
  ].includes(value);
}

/**
 * 热加载槽位宿主：每次 apply 计算下一组插件的全部注册，
 * 全部成功后才替换；任一失败则清退新注册、恢复旧内容。
 */
export function createHotSlotHost(options: {
  readonly registry?: SlotRegistry;
  readonly declaredSlots?: readonly (keyof ZetaSlots)[];
} = {}): HotSlotHost {
  const registry = options.registry ?? createSlotRegistry();
  const allowed = new Set<string>(
    options.declaredSlots ?? ["header", "footer", "message", "tool", "editor", "overlay", "hud"],
  );
  let activeIds: readonly string[] = [];

  return {
    apply(plugins) {
      const disposers: Array<() => void> = [];
      try {
        const ids: string[] = [];
        for (const plugin of plugins) {
          for (const [slot, content] of Object.entries(plugin.slots)) {
            if (!allowed.has(slot) || !isSlotName(slot)) {
              throw new Error(`SLOT_UNDECLARED: ${slot}`);
            }
            disposers.push(registry.register(slot, content).dispose);
          }
          ids.push(plugin.id);
        }
        activeIds = ids;
        return { ok: true, activeIds: ids };
      } catch (error) {
        for (const dispose of disposers.reverse()) dispose();
        return { ok: false, activeIds: activeIds, error };
      }
    },
    render(slot) {
      return registry.render(slot);
    },
    current() {
      return [...activeIds];
    },
  };
}
