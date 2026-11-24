import type { CliRenderer } from "@opentui/core";
import {
  createSolidSlotRegistry,
  createSlot,
  type PluginContext,
  type PluginErrorEvent,
  type SlotRegistryOptions,
  type SolidPlugin,
  type SolidSlotComponent,
  type SolidSlotRegistry,
  type ZetaNativeSlots,
} from "./slots-native";

type SlotMap = Record<string, object>;

export type { PluginErrorEvent, SolidPlugin, ZetaNativeSlots };

export interface SlotApplyResult {
  readonly ok: boolean;
  readonly activeIds: readonly string[];
  readonly error?: unknown;
}

/** 生产 App 槽位宿主：响应式注册/注销、A→B→A 热替换、坏插件回退与显式清理。 */
export interface ReactiveSlotHost<TSlots extends SlotMap> {
  readonly registry: SolidSlotRegistry<TSlots>;
  readonly BoundSlot: SolidSlotComponent<TSlots>;
  register(plugin: SolidPlugin<TSlots>): () => void;
  unregister(id: string): boolean;
  onPluginError(listener: (event: PluginErrorEvent) => void): () => void;
  apply(plugins: readonly SolidPlugin<TSlots>[]): SlotApplyResult;
  activeIds(): readonly string[];
  dispose(): void;
}

interface ActiveEntry<TSlots extends SlotMap> {
  readonly plugin: SolidPlugin<TSlots>;
  readonly registryId: string;
  readonly off: () => void;
}

export function createReactiveSlotHost<TSlots extends SlotMap = ZetaNativeSlots>(
  renderer: CliRenderer,
  context: PluginContext = {},
  options: SlotRegistryOptions = {},
): ReactiveSlotHost<TSlots> {
  const registry = createSolidSlotRegistry<TSlots>(renderer, context, options);
  const BoundSlot = createSlot<TSlots>(registry);
  const active = new Map<string, ActiveEntry<TSlots>>();
  const errorListeners = new Set<(event: PluginErrorEvent) => void>();
  /** 上一次生效的插件组：坏插件在渲染期失败时回滚到这里。 */
  let rollback = new Map<string, SolidPlugin<TSlots>>();
  let disposed = false;
  let registrationSeq = 0;

  const assertAlive = (): void => {
    if (disposed) throw new Error("ReactiveSlotHost: already disposed");
  };

  const register = (plugin: SolidPlugin<TSlots>): (() => void) => {
    assertAlive();
    if (typeof plugin.id !== "string" || plugin.id.length === 0) {
      throw new Error("SLOT_PLUGIN_ID_INVALID");
    }
    if (active.has(plugin.id)) throw new Error(`SLOT_PLUGIN_DUPLICATE: ${plugin.id}`);
    // 官方注册表按 id 缓存槽位节点，同 id 重新注册不会重绘；每次注册分配唯一 id。
    const registryId = `${plugin.id}#${++registrationSeq}`;
    const wrapped = { ...plugin, id: registryId } as SolidPlugin<TSlots>;
    let off: () => void;
    try {
      off = registry.register(wrapped);
    } catch (error) {
      throw new Error(`SLOT_PLUGIN_REGISTER_FAILED: ${plugin.id}`, { cause: error });
    }
    const entry: ActiveEntry<TSlots> = { plugin, registryId, off };
    active.set(plugin.id, entry);
    return () => {
      if (active.get(plugin.id) !== entry) return;
      entry.off();
      active.delete(plugin.id);
    };
  };

  const unregister = (id: string): boolean => {
    const entry = active.get(id);
    if (entry === undefined) return false;
    entry.off();
    active.delete(id);
    return true;
  };

  const restore = (plugins: readonly SolidPlugin<TSlots>[]): void => {
    for (const plugin of plugins) {
      if (active.has(plugin.id)) continue;
      try {
        register(plugin);
      } catch {
        // 回退失败时保留基础内容；错误继续由 onPluginError 上报。
      }
    }
  };

  const offError = registry.onPluginError((event) => {
    const entry = [...active.values()].find((candidate) => candidate.registryId === event.pluginId);
    const normalized: PluginErrorEvent = {
      ...event,
      pluginId: entry?.plugin.id ?? event.pluginId,
    };
    for (const listener of [...errorListeners]) listener(normalized);
    if (event.phase !== "setup" && event.phase !== "render") return;
    registry.batch(() => {
      if (entry !== undefined) unregister(entry.plugin.id);
      restore([...rollback.values()]);
    });
  });

  const apply = (plugins: readonly SolidPlugin<TSlots>[]): SlotApplyResult => {
    assertAlive();
    const previous = [...active.values()].map((entry) => entry.plugin);
    rollback = new Map(previous.map((plugin) => [plugin.id, plugin]));
    const added: string[] = [];
    // 连续注销/注册必须合并为一次通知，否则 Solid BoundSlot 的 microtask 去抖会漏掉最终状态。
    return registry.batch(() => {
      try {
        for (const plugin of previous) unregister(plugin.id);
        for (const plugin of plugins) {
          register(plugin);
          added.push(plugin.id);
        }
        return { ok: true, activeIds: added };
      } catch (error) {
        for (const id of added.reverse()) unregister(id);
        restore(previous);
        return { ok: false, activeIds: previous.map((plugin) => plugin.id), error };
      }
    });
  };

  return {
    registry,
    BoundSlot,
    register,
    unregister(id) {
      assertAlive();
      return unregister(id);
    },
    onPluginError(listener) {
      assertAlive();
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
    apply,
    activeIds() {
      return [...active.keys()];
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      registry.batch(() => {
        for (const plugin of [...active.values()].map((entry) => entry.plugin)) {
          unregister(plugin.id);
        }
      });
      offError();
      errorListeners.clear();
      rollback.clear();
    },
  };
}
