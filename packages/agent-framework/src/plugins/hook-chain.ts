import type { Disposer } from "@zeta-agent/framework";

export type HookDispatchMode = "serial" | "parallel";

/** 归一化后的 hook 失败记录：任意抛出值统一为 Error，便于上报为 isError 事件。 */
export interface HookFailure {
  readonly index: number;
  readonly name: string;
  readonly error: Error;
}

export interface HookChainOptions {
  readonly mode?: HookDispatchMode;
  readonly defaultPriority?: number;
  readonly onError?: (failure: HookFailure) => void;
  /** true：归一化后继续向上传播；false（默认）：以安全回退值继续链条。 */
  readonly rethrow?: boolean;
  readonly name?: string;
}

export type HookFn<I> = (input: I, signal?: AbortSignal) => unknown | Promise<unknown>;

export interface HookEntry<I> {
  readonly fn: HookFn<I>;
  readonly priority: number;
  readonly order: number;
  readonly name: string;
}

export const DEFAULT_HOOK_PRIORITY = 100;

export function normalizeHookError(error: unknown, name: string, index: number): HookFailure {
  const normalized = error instanceof Error ? error : new Error(String(error));
  return { index, name, error: normalized };
}

/**
 * 有序 hook 链：priority 升序、同值按注册序；add 返回幂等 disposer，disposeAll 按 LIFO 撤销。
 * 串行逐一 await 并折叠返回值（undefined 保持当前值）；并行用 Promise.allSettled 收集。
 */
export class HookChain<I = unknown> {
  private readonly entries: HookEntry<I>[] = [];
  private readonly modeValue: HookDispatchMode;
  private readonly defaultPriorityValue: number;
  private readonly onError: HookChainOptions["onError"];
  private readonly rethrowValue: boolean;
  private readonly chainName: string;
  private sequence = 0;
  private failures: HookFailure[] = [];

  constructor(options: HookChainOptions = {}) {
    this.modeValue = options.mode ?? "serial";
    this.defaultPriorityValue = options.defaultPriority ?? DEFAULT_HOOK_PRIORITY;
    this.onError = options.onError;
    this.rethrowValue = options.rethrow ?? false;
    this.chainName = options.name ?? "hook";
  }

  get mode(): HookDispatchMode {
    return this.modeValue;
  }

  get name(): string {
    return this.chainName;
  }

  get size(): number {
    return this.entries.length;
  }

  get names(): readonly string[] {
    return this.sorted().map((entry) => entry.name);
  }

  get lastFailures(): readonly HookFailure[] {
    return [...this.failures];
  }

  add(fn: HookFn<I>, priority: number = this.defaultPriorityValue, name?: string): Disposer {
    if (typeof fn !== "function") throw new Error("HookChain.add: expected a function");
    const order = this.sequence++;
    const entry: HookEntry<I> = {
      fn,
      priority,
      order,
      name: name ?? `${this.chainName}#${order}`,
    };
    this.entries.push(entry);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const index = this.entries.indexOf(entry);
      if (index >= 0) this.entries.splice(index, 1);
    };
  }

  snapshot(): readonly HookEntry<I>[] {
    return this.sorted();
  }

  async run(input: I, signal?: AbortSignal): Promise<I> {
    this.failures = [];
    const ordered = this.sorted();
    if (this.modeValue === "parallel") return this.runParallel(ordered, input, signal);
    return this.runSerial(ordered, input, signal);
  }

  disposeAll(): void {
    for (const entry of [...this.entries].reverse()) {
      const index = this.entries.indexOf(entry);
      if (index >= 0) this.entries.splice(index, 1);
    }
  }

  clear(): void {
    this.disposeAll();
    this.failures = [];
  }

  private sorted(): HookEntry<I>[] {
    return [...this.entries].sort((left, right) =>
      left.priority - right.priority || left.order - right.order
    );
  }

  private async runSerial(ordered: readonly HookEntry<I>[], input: I, signal?: AbortSignal): Promise<I> {
    let current = input;
    for (const [index, entry] of ordered.entries()) {
      try {
        const value = await entry.fn(current, signal);
        if (value !== undefined) current = value as I;
      } catch (error) {
        const failure = normalizeHookError(error, entry.name, index);
        this.failures.push(failure);
        this.onError?.(failure);
        if (this.rethrowValue) throw failure.error;
      }
    }
    return current;
  }

  private async runParallel(
    ordered: readonly HookEntry<I>[],
    input: I,
    signal?: AbortSignal
  ): Promise<I> {
    const settled = await Promise.allSettled(
      ordered.map(async (entry) => await entry.fn(input, signal))
    );
    let result = input;
    settled.forEach((item, index) => {
      const entry = ordered[index];
      if (item.status === "rejected") {
        const failure = normalizeHookError(item.reason, entry?.name ?? `hook-${index}`, index);
        this.failures.push(failure);
        this.onError?.(failure);
        return;
      }
      if (item.value !== undefined) result = item.value as I;
    });
    if (this.rethrowValue && this.failures.length > 0) {
      throw new AggregateError(
        this.failures.map((failure) => failure.error),
        `${this.chainName}: hook failures`
      );
    }
    return result;
  }
}

export function createHookChain<I = unknown>(options?: HookChainOptions): HookChain<I> {
  return new HookChain<I>(options);
}
