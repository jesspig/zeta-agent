import type { AgentTool as FrameworkAgentTool } from "@zeta-agent/agent-framework";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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

/** 可注入的持久化快照：seq / pending / receipts / seen 五要素的完整载体。 */
export interface DurableSnapshot {
  readonly seq: number;
  readonly pending: readonly DurableIntent[];
  readonly receipts: readonly Receipt[];
  readonly seen: readonly string[];
}

/** 显式注入才落盘；默认使用内存实现以保证测试隔离。 */
export interface DurableJournal {
  load(): DurableSnapshot | undefined;
  save(snapshot: DurableSnapshot): void;
}

export interface DurableEffectsOptions {
  readonly journal?: DurableJournal;
}

export interface RecoverResult {
  readonly restored: boolean;
  readonly pending: number;
  readonly receipts: number;
}

export interface DurableEffects {
  enqueue(kind: string, key: string, payload: unknown): void;
  commit(): Promise<readonly Receipt[]>;
  pending(): readonly DurableIntent[];
  receipts(): readonly Receipt[];
  /** 重启恢复入口：从注入的 journal 重新载入 outbox / 回执 / 幂等键。 */
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

/** 文件 journal：append-only 语义由「先落回执再从 pending 移除」保证。 */
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
  const restored = journal.load();
  let seq = restored?.seq ?? 0;
  let pending: DurableIntent[] = restored ? [...restored.pending] : [];
  const receipts: Receipt[] = restored ? [...restored.receipts] : [];
  const seen = new Set<string>(restored?.seen ?? []);

  const persist = (): void => {
    journal.save({ seq, pending: [...pending], receipts: [...receipts], seen: [...seen] });
  };

  return {
    enqueue(kind, key, payload) {
      assertKey(kind, "effects.enqueue kind");
      assertKey(key, "effects.enqueue key");
      const identity = `${kind}\u0000${key}`;
      if (seen.has(identity)) return;
      seen.add(identity);
      seq += 1;
      pending = [...pending, { kind, key, seq, payload }];
      persist();
    },
    async commit() {
      const results: Receipt[] = [];
      while (pending.length > 0) {
        const intent = pending[0]!;
        let receipt: Receipt;
        try {
          const value = await dispatch(intent);
          receipt = { kind: intent.kind, key: intent.key, ok: true, value };
        } catch {
          receipt = { kind: intent.kind, key: intent.key, ok: false };
        }
        pending = pending.slice(1);
        receipts.push(receipt);
        results.push(receipt);
        // 每条 intent 必须先有回执再离开 outbox，崩溃重启后不会重复派发。
        persist();
      }
      return results;
    },
    pending: () => [...pending],
    receipts: () => [...receipts],
    recover() {
      const snapshot = journal.load();
      if (snapshot === undefined) return { restored: false, pending: pending.length, receipts: receipts.length };
      seq = snapshot.seq;
      pending = [...snapshot.pending];
      receipts.splice(0, receipts.length, ...snapshot.receipts);
      seen.clear();
      for (const identity of snapshot.seen) seen.add(identity);
      return { restored: true, pending: pending.length, receipts: receipts.length };
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
