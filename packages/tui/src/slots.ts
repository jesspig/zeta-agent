import type { AgentMessage } from "@zeta-agent/agent";

export interface ZetaSlots {
  readonly header: undefined;
  readonly footer: undefined;
  readonly message: { readonly message: AgentMessage };
  readonly tool: { readonly toolCall: { readonly id: string; readonly name: string; readonly args: unknown } };
  readonly editor: undefined;
  readonly overlay: undefined;
}

export const ZETA_SLOT_NAMES: readonly (keyof ZetaSlots)[] = Object.freeze([
  "header",
  "footer",
  "message",
  "tool",
  "editor",
  "overlay",
  "hud",
]);

export interface SlotHandle {
  readonly slot: keyof ZetaSlots;
  dispose(): void;
}

export interface SlotRegistry {
  register<K extends keyof ZetaSlots>(slot: K, content: string): SlotHandle;
  render(slot: keyof ZetaSlots): string;
  slots(): readonly (keyof ZetaSlots)[];
}

export function createSlotRegistry(): SlotRegistry {
  const contents = new Map<keyof ZetaSlots, string>();
  const allowed = new Set<string>(ZETA_SLOT_NAMES as readonly string[]);

  function assertDeclared(slot: keyof ZetaSlots): void {
    if (!allowed.has(slot as string)) throw new Error(`SLOT_UNDECLARED: ${String(slot)}`);
  }

  function register<K extends keyof ZetaSlots>(slot: K, content: string): SlotHandle {
    assertDeclared(slot);
    if (typeof content !== "string") throw new Error("SLOT_CONTENT_INVALID");
    const previous = contents.get(slot);
    contents.set(slot, content);
    let active = true;
    return {
      slot,
      dispose() {
        if (!active) return;
        active = false;
        if (previous === undefined) contents.delete(slot);
        else contents.set(slot, previous);
      },
    };
  }

  function render(slot: keyof ZetaSlots): string {
    assertDeclared(slot);
    return contents.get(slot) ?? "";
  }

  return { register, render, slots: () => [...ZETA_SLOT_NAMES] };
}
