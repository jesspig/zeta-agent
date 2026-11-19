import type { AgentTool as FrameworkAgentTool } from "@zeta-agent/agent-framework";

export type ReplayPolicy = "never" | "safe";

export interface AgentTool<P = unknown> extends FrameworkAgentTool<P> {
  readonly replay: ReplayPolicy;
}

export interface DurableIntent {
  readonly kind: string;
  readonly key: string;
  readonly seq: number;
  readonly payload: unknown;
}

export interface Receipt {
  readonly kind: string;
  readonly key: string;
  readonly ok: boolean;
  readonly value?: unknown;
}

export type Dispatch = (intent: DurableIntent) => unknown | Promise<unknown>;

export interface DurableEffects {
  enqueue(kind: string, key: string, payload: unknown): void;
  commit(): Promise<readonly Receipt[]>;
  pending(): readonly DurableIntent[];
  receipts(): readonly Receipt[];
}

export interface StepResult<T> {
  readonly value: T;
  readonly created: boolean;
}

export interface StepLedger {
  step<T>(stepKey: string, fn: () => T | Promise<T>): Promise<StepResult<T>>;
  has(stepKey: string): boolean;
}

export interface ReplayRequest<P = unknown> {
  readonly tool: AgentTool<P>;
  readonly stepKey: string;
  readonly input: P;
  readonly ledger: StepLedger;
  readonly recorded?: unknown;
  readonly canReconstruct?: boolean;
}

export interface ReplayOutcome {
  readonly action: "replayed" | "verified-fact";
  readonly value?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKey(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label}: expected a non-empty string`);
  }
}

export function createStepLedger(): StepLedger {
  const values = new Map<string, unknown>();
  const inFlight = new Map<string, Promise<StepResult<unknown>>>();

  return {
    step<T>(stepKey: string, fn: () => T | Promise<T>) {
      assertKey(stepKey, "step");
      if (typeof fn !== "function") throw new Error("step: expected a callback");
      if (values.has(stepKey)) {
        return Promise.resolve({ value: values.get(stepKey) as T, created: false });
      }
      const running = inFlight.get(stepKey);
      if (running !== undefined) return running as Promise<StepResult<T>>;

      const task = Promise.resolve()
        .then(() => fn())
        .then(
          (value) => {
            values.set(stepKey, value);
            inFlight.delete(stepKey);
            return { value: value as T, created: true };
          },
          (error: unknown) => {
            inFlight.delete(stepKey);
            throw error;
          }
        );
      inFlight.set(stepKey, task as Promise<StepResult<unknown>>);
      return task as Promise<StepResult<T>>;
    },
    has(stepKey) {
      return values.has(stepKey);
    },
  };
}

export function createDurableEffects(dispatch: Dispatch): DurableEffects {
  if (typeof dispatch !== "function") throw new Error("effects: expected a dispatch function");
  let seq = 0;
  let pending: DurableIntent[] = [];
  const receipts: Receipt[] = [];
  const seen = new Set<string>();

  return {
    enqueue(kind, key, payload) {
      assertKey(kind, "effects.enqueue kind");
      assertKey(key, "effects.enqueue key");
      const identity = `${kind}\u0000${key}`;
      if (seen.has(identity)) return;
      seen.add(identity);
      seq += 1;
      pending = [...pending, { kind, key, seq, payload }];
    },
    async commit() {
      const batch = pending;
      pending = [];
      const results: Receipt[] = [];
      for (const intent of batch) {
        try {
          const value = await dispatch(intent);
          const receipt: Receipt = { kind: intent.kind, key: intent.key, ok: true, value };
          results.push(receipt);
          receipts.push(receipt);
        } catch {
          const receipt: Receipt = { kind: intent.kind, key: intent.key, ok: false };
          results.push(receipt);
          receipts.push(receipt);
        }
      }
      return results;
    },
    pending: () => [...pending],
    receipts: () => [...receipts],
  };
}

export async function replayToolCall<P>(request: ReplayRequest<P>): Promise<ReplayOutcome> {
  if (!isRecord(request)) throw new Error("replay: invalid request");
  const { tool, stepKey, input, ledger, recorded, canReconstruct } = request as ReplayRequest<P>;
  if (!isRecord(tool)) throw new Error("replay: invalid tool");
  if (tool.replay !== "never" && tool.replay !== "safe") {
    throw new Error("replay: invalid replay policy");
  }
  assertKey(stepKey, "replay stepKey");
  if (!isRecord(ledger) || typeof ledger.step !== "function") {
    throw new Error("replay: invalid ledger");
  }

  const reconstruct = tool.replay === "safe" && canReconstruct !== false;
  if (!reconstruct) {
    if (recorded === undefined) throw new Error("replay: verified fact required");
    return { action: "verified-fact", value: recorded };
  }

  const result = await ledger.step(stepKey, () => tool.execute(input));
  return { action: "replayed", value: result.value };
}
