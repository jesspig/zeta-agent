export interface Emission {
  readonly id: string;
  readonly kind: string;
  readonly payload: unknown;
}

export interface WithholdHandle {
  readonly emission: Emission;
  readonly status: "withheld";
}

export interface WithheldEmission {
  readonly emission: Emission;
  readonly revoke?: (emission: Emission) => void;
}

export interface Outbox {
  readonly pending: readonly WithheldEmission[];
  withhold(emission: Emission, revoke?: (emission: Emission) => void): WithholdHandle;
  compensate(id: string): void;
  isWithheld(id: string): boolean;
}

export interface WithholdOptions {
  readonly outbox: Outbox;
  readonly revoke?: (emission: Emission) => void;
}

export function createOutbox(): Outbox {
  const pending: WithheldEmission[] = [];

  return {
    get pending(): readonly WithheldEmission[] {
      return pending;
    },
    withhold(emission: Emission, revoke?: (emission: Emission) => void): WithholdHandle {
      if (pending.some((item) => item.emission.id === emission.id)) {
        throw new Error("EMISSION_ALREADY_WITHHELD");
      }
      pending.push({ emission, revoke });
      return { emission, status: "withheld" };
    },
    compensate(id: string): void {
      const index = pending.findIndex((item) => item.emission.id === id);
      if (index < 0) throw new Error("UNKNOWN_EMISSION");
      const [entry] = pending.splice(index, 1);
      entry?.revoke?.(entry.emission);
    },
    isWithheld(id: string): boolean {
      return pending.some((item) => item.emission.id === id);
    },
  };
}

export function withholdEmission(emission: Emission, options: WithholdOptions): WithholdHandle {
  return options.outbox.withhold(emission, options.revoke);
}
