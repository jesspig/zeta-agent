import type { AgentTool as FrameworkAgentTool } from "@zeta-agent/agent-framework";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  createPersistentOutbox,
  type OutboxEntry,
  type OutboxJournal,
  type OutboxReceipt,
  type OutboxSnapshot,
} from "@zeta-agent/security";

export type ReplayPolicy = "never" | "safe";

export interface AgentTool<P = unknown> extends FrameworkAgentTool<P> {
  readonly replay: ReplayPolicy;
}

export type DurableIntent = OutboxEntry;
export type Receipt = OutboxReceipt;
export type DurableSnapshot = OutboxSnapshot;
export type DurableJournal = OutboxJournal;

export interface DispatchContext {
  /** 稳定幂等键：同一 (kind,key) 的所有 generation / retry 共用。 */
  readonly idempotencyKey: string;
  readonly generation: number;
  readonly attempt: number;
  readonly seq: number;
}

export type Dispatch = (intent: DurableIntent, context: DispatchContext) => unknown | Promise<unknown>;

/** 正常等待信号：不记失败、不进 health，稍后由 retryDeferred 重新可派发。 */
export class Later extends Error {
  readonly delayMs: number;
  constructor(delayMs = 0) {
    super(`LATER:${delayMs}`);
    this.name = "Later";
    this.delayMs = delayMs;
  }
}

export function later(delayMs = 0): never {
  throw new Later(delayMs);
}

export interface DurableEffectsOptions {
  readonly journal?: DurableJournal;
  readonly maxAttempts?: number;
  readonly healthThreshold?: number;
  readonly backoffMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export interface RecoverResult {
  readonly restored: boolean;
  readonly pending: number;
  readonly receipts: number;
}

export interface OutboxHealth {
  readonly ok: boolean;
  readonly consecutiveFailures: number;
  readonly reason?: string;
}

export interface DurableEffects {
  enqueue(kind: string, key: string, payload: unknown): DurableIntent;
  commit(): Promise<readonly Receipt[]>;
  pending(): readonly DurableIntent[];
  receipts(): readonly Receipt[];
  /** 当前可派发意图；unknown / 未来 deferred 都不在其中。 */
  dispatchable(): readonly DurableIntent[];
  unknownIntents(): readonly DurableIntent[];
  /** 未知结果人工对账后落回执，不重新派发。 */
  reconcile(key: string, ok: boolean, value?: unknown): Receipt;
  retryDeferred(): void;
  health(): OutboxHealth;
  resetHealth(): void;
  /** 重启恢复入口：outbox 构造时已自动恢复，这里返回对账所需快照。 */
  recover(): RecoverResult;
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

export function createInMemoryDurableJournal(): DurableJournal {
  let snapshot: DurableSnapshot | undefined;
  return {
    load: () => snapshot,
    save: (next) => {
      snapshot = structuredClone(next) as DurableSnapshot;
    },
  };
}

/** 文件 journal：状态转换逐次落盘，回执先于出队写入。 */
export function createFileDurableJournal(filePath: string): DurableJournal {
  assertKey(filePath, "durable journal path");
  return {
    load() {
      if (!existsSync(filePath)) return undefined;
      const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      if (!isRecord(parsed) || !Array.isArray(parsed.pending) || !Array.isArray(parsed.receipts) || !Array.isArray(parsed.seen)) {
        throw new Error("INVALID_DURABLE_JOURNAL");
      }
      return parsed as unknown as DurableSnapshot;
    },
    save(snapshot) {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, JSON.stringify(snapshot), "utf8");
    },
  };
}

export function createDurableEffects(dispatch: Dispatch, options: DurableEffectsOptions = {}): DurableEffects {
  if (typeof dispatch !== "function") throw new Error("effects: expected a dispatch function");
  const journal = options.journal ?? createInMemoryDurableJournal();
  const outbox = createPersistentOutbox({
    journal,
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    ...(options.healthThreshold === undefined ? {} : { healthThreshold: options.healthThreshold }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const backoffMs = options.backoffMs ?? 0;
  const sleep = options.sleep ?? (async (ms: number) => {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  });
  let committing: Promise<readonly Receipt[]> | undefined;

  return {
    enqueue(kind, key, payload) {
      return outbox.enqueue(kind, key, payload);
    },
    commit() {
      if (committing !== undefined) return committing;
      committing = (async () => {
        const results: Receipt[] = [];
        while (outbox.health().ok) {
          const next = outbox.dispatchable()[0];
          if (next === undefined) break;
          const started = outbox.beginDispatch(next);
          const context: DispatchContext = {
            idempotencyKey: started.idempotencyKey,
            generation: started.generation,
            attempt: started.attempts,
            seq: started.seq,
          };
          try {
            const value = await dispatch(started, context);
            results.push(outbox.settle(started, true, value));
          } catch (error) {
            if (error instanceof Later) {
              outbox.later(started, error.delayMs);
              continue;
            }
            const outcome = outbox.fail(started);
            if (outcome.retry) {
              if (backoffMs > 0) await sleep(backoffMs);
              continue;
            }
            results.push(outcome.receipt);
          }
        }
        return results;
      })();
      const active = committing;
      void active.finally(() => {
        if (committing === active) committing = undefined;
      });
      return active;
    },
    pending: () => outbox.entries(),
    receipts: () => outbox.receipts(),
    dispatchable: () => outbox.dispatchable(),
    unknownIntents: () => outbox.unknown(),
    reconcile(key, ok, value) {
      return outbox.reconcile(key, ok, value);
    },
    retryDeferred() {
      outbox.retryDeferred();
    },
    health: () => outbox.health(),
    resetHealth() {
      outbox.resetHealth();
    },
    recover() {
      const result = outbox.recover();
      return { restored: result.restored, pending: result.pending, receipts: result.receipts };
    },
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
