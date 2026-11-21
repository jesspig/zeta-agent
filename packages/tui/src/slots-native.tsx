import {
  createSolidSlotRegistry as createOfficialSolidSlotRegistry,
  createSlot as createOfficialSlot,
  Slot as OfficialSlot,
} from "@opentui/solid";
import type { CliRenderer } from "@opentui/core";
import type {
  PluginContext,
  SlotRegistryOptions,
  SlotRegistry as CoreSlotRegistry,
} from "@opentui/core";
import type { JSX } from "@opentui/solid";
import { useRenderer as useRendererFromSolid } from "@opentui/solid";
import type {
  SolidPlugin,
  SolidSlotProps,
  SolidSlotComponent,
  SolidSlotOptions,
} from "@opentui/solid";

type SlotMap = Record<string, object>;

/** 生产官方 Solid 槽位：插件可 replace/extend 这些 UI 区域。 */
export interface ZetaNativeSlots {
  readonly [key: string]: object;
  readonly header: object;
  readonly footer: object;
  readonly message: object;
  readonly tool: object;
  readonly editor: object;
  readonly overlay: object;
  readonly hud: object;
}

export const ZETA_NATIVE_SLOT_NAMES: readonly (keyof ZetaNativeSlots)[] = Object.freeze([
  "header", "footer", "message", "tool", "editor", "overlay", "hud",
]);

export type {
  SolidPlugin,
  SolidSlotProps,
  SolidSlotComponent,
  SolidSlotOptions,
} from "@opentui/solid";
export type {
  PluginContext,
  PluginErrorEvent,
  PluginErrorPhase,
  SlotMode,
  SlotRegistryOptions,
} from "@opentui/core";

export type SolidSlotRegistry<
  TSlots extends SlotMap,
  TContext extends PluginContext = PluginContext,
> = CoreSlotRegistry<JSX.Element, TSlots, TContext>;

export function createSolidSlotRegistry<
  TSlots extends SlotMap,
  TContext extends PluginContext = PluginContext,
>(
  renderer: CliRenderer,
  context: TContext,
  options?: SlotRegistryOptions,
): SolidSlotRegistry<TSlots, TContext> {
  return createOfficialSolidSlotRegistry<TSlots, TContext>(
    renderer,
    context,
    options,
  );
}

export function createSlot<
  TSlots extends SlotMap,
  TContext extends PluginContext = PluginContext,
>(
  registry: SolidSlotRegistry<TSlots, TContext>,
  options?: SolidSlotOptions,
): SolidSlotComponent<TSlots> {
  return createOfficialSlot<TSlots, TContext>(registry, options);
}

export function Slot<
  TSlots extends SlotMap,
  TContext extends PluginContext = PluginContext,
  K extends keyof TSlots = keyof TSlots,
>(props: SolidSlotProps<TSlots, K, TContext>): JSX.Element {
  return OfficialSlot<TSlots, TContext, K>(props);
}

/**
 * 生产 App 的官方槽位绑定：基于当前 renderer 创建注册表，注册插件并返回绑定后的 Slot 组件。
 * 插件 replace/extend 失败时官方注册表保留基础内容（closure rule）。
 */
export function useZetaSlots(plugins: readonly SolidPlugin<ZetaNativeSlots>[] = []) {
  // useRenderer 必须在渲染上下文调用；此处经动态读取避免额外 import 依赖。
  const renderer = useRendererFromSolid();
  const registry = createSolidSlotRegistry<ZetaNativeSlots>(renderer, {});
  for (const plugin of plugins) registry.register(plugin);
  const BoundSlot = createSlot<ZetaNativeSlots>(registry);
  return { registry, BoundSlot };
}
