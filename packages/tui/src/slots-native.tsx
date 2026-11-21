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
import type {
  SolidPlugin,
  SolidSlotProps,
  SolidSlotComponent,
  SolidSlotOptions,
} from "@opentui/solid";

type SlotMap = Record<string, object>;

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
