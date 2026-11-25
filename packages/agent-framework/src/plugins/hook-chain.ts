import type { Disposer } from "@zeta-agent/framework";

export type HookDispatchMode = "serial" | "parallel";

/** 归一化后的 hook 失败记录：任意抛出值统一为 Error，便于上报为 isError 事件。 */
export interface HookFailure {
  readonly index: number;
  readonly name: string;
  readonly error: Error;
}

/** 依赖图环失败：只让环内条目 FAILED，链上其他条目继续参与排序与执行。 */
export interface HookCycleFailure {
  readonly chain: string;
  readonly name: string;
  readonly cycle: readonly string[];
}

export interface HookAddOptions {
  /** 必须先于本 hook 执行的条目名；参与拓扑排序与环检测。 */
  readonly dependsOn?: readonly string[];
}

export interface HookRunOptions {
  /** 反向执行（wrap 的 after 阶段）；不改变排序结果，只反转遍历顺序。 */
  readonly reverse?: boolean;
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
  readonly dependsOn: readonly string[];
  readonly status: "ACTIVE" | "FAILED";
  readonly failureReason?: string;
}

export const DEFAULT_HOOK_PRIORITY = 100;

export function normalizeHookError(error: unknown, name: string, index: number): HookFailure {
  const normalized = error instanceof Error ? error : new Error(String(error));
  return { index, name, error: normalized };
}

function compareEntries<I>(left: HookEntry<I>, right: HookEntry<I>): number {
  return left.priority - right.priority || left.order - right.order;
}

interface ResolvedGraph<I> {
  readonly ordered: readonly HookEntry<I>[];
  readonly failed: readonly HookEntry<I>[];
  readonly cycles: readonly HookCycleFailure[];
}

/**
 * 有序 hook 链：priority 升序、同值按注册序，dependsOn 参与拓扑排序；
 * 环内条目被隔离为 FAILED（HOOK_CYCLE），其他条目照常执行。
 * add 返回幂等 disposer，disposeAll 按 LIFO 撤销。
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

  get activeSize(): number {
    return this.snapshot().length;
  }

  get names(): readonly string[] {
    return this.snapshot().map((entry) => entry.name);
  }

  get lastFailures(): readonly HookFailure[] {
    return [...this.failures];
  }

  /** 当前依赖图中的环；每个环只标记环内条目，不影响其他 hook。 */
  get cycles(): readonly HookCycleFailure[] {
    return this.resolveGraph().cycles;
  }

  /** 因环被隔离的条目（status=FAILED，failureReason=HOOK_CYCLE）。 */
  get failedEntries(): readonly HookEntry<I>[] {
    return this.resolveGraph().failed;
  }

  add(
    fn: HookFn<I>,
    priority: number = this.defaultPriorityValue,
    name?: string,
    options: HookAddOptions = {}
  ): Disposer {
    if (typeof fn !== "function") throw new Error("HookChain.add: expected a function");
    const order = this.sequence++;
    const entry: HookEntry<I> = {
      fn,
      priority,
      order,
      name: name ?? `${this.chainName}#${order}`,
      dependsOn: Object.freeze([...(options.dependsOn ?? [])]),
      status: "ACTIVE",
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

  /** 通过拓扑排序后的活跃条目快照；排除环内 FAILED 条目。 */
  snapshot(): readonly HookEntry<I>[] {
    return this.resolveGraph().ordered;
  }

  async run(input: I, signal?: AbortSignal, options: HookRunOptions = {}): Promise<I> {
    this.failures = [];
    const sorted = this.snapshot();
    const ordered = options.reverse === true ? [...sorted].reverse() : sorted;
    if (this.modeValue === "parallel") return this.runParallel(ordered, input, signal);
    return this.runSerial(ordered, input, signal);
  }

  /** 逐条目执行并把结果交给 visit；用于 converter 这类需要逐项发射的 hook。 */
  async runEach(
    input: I,
    signal: AbortSignal | undefined,
    visit: (value: unknown, entry: HookEntry<I>) => void | Promise<void>
  ): Promise<void> {
    this.failures = [];
    const ordered = this.snapshot();
    for (const [index, entry] of ordered.entries()) {
      try {
        const value = await entry.fn(input, signal);
        await visit(value, entry);
      } catch (error) {
        const failure = normalizeHookError(error, entry.name, index);
        this.failures.push(failure);
        this.onError?.(failure);
        if (this.rethrowValue) throw failure.error;
      }
    }
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

  private resolveGraph(): ResolvedGraph<I> {
    const byName = new Map<string, HookEntry<I>>();
    for (const entry of this.entries) {
      if (!byName.has(entry.name)) byName.set(entry.name, entry);
    }
    const lookup = (name: string): HookEntry<I> | undefined => {
      const exact = byName.get(name);
      if (exact !== undefined) return exact;
      const suffix = `:${name}`;
      const matches = this.entries.filter((entry) => entry.name.endsWith(suffix));
      return matches.length === 1 ? matches[0] : undefined;
    };

    const cycles: HookCycleFailure[] = [];
    const failedNames = new Set<string>();
    const state = new Map<string, 0 | 1 | 2>();
    const stack: string[] = [];
    const visit = (entry: HookEntry<I>): void => {
      state.set(entry.name, 1);
      stack.push(entry.name);
      for (const dependency of entry.dependsOn) {
        const target = lookup(dependency);
        if (target === undefined) continue;
        if (target === entry) {
          const cycle = [entry.name, entry.name];
          cycles.push({ chain: this.chainName, name: entry.name, cycle });
          for (const name of cycle) failedNames.add(name);
          continue;
        }
        const visited = state.get(target.name) ?? 0;
        if (visited === 0) visit(target);
        else if (visited === 1) {
          const start = stack.indexOf(target.name);
          const cycle = [...stack.slice(start), target.name];
          cycles.push({ chain: this.chainName, name: entry.name, cycle });
          for (const name of cycle) failedNames.add(name);
        }
      }
      stack.pop();
      state.set(entry.name, 2);
    };
    for (const entry of this.entries) {
      if ((state.get(entry.name) ?? 0) === 0) visit(entry);
    }

    const active = this.entries.filter((entry) => !failedNames.has(entry.name));
    const activeSet = new Set(active);
    const indegree = new Map(active.map((entry) => [entry, 0]));
    const dependents = new Map(active.map((entry) => [entry, [] as HookEntry<I>[]]));
    for (const entry of active) {
      for (const dependency of entry.dependsOn) {
        const target = lookup(dependency);
        if (target === undefined || target === entry || !activeSet.has(target)) continue;
        indegree.set(entry, (indegree.get(entry) ?? 0) + 1);
        dependents.get(target)!.push(entry);
      }
    }
    const ready = active.filter((entry) => indegree.get(entry) === 0);
    const ordered: HookEntry<I>[] = [];
    while (ready.length > 0) {
      ready.sort(compareEntries);
      const current = ready.shift()!;
      ordered.push(current);
      for (const child of dependents.get(current) ?? []) {
        const remaining = (indegree.get(child) ?? 0) - 1;
        indegree.set(child, remaining);
        if (remaining === 0) ready.push(child);
      }
    }
    // 防御：若仍有未出队条目（异常图），只隔离它们，不拖垮已排序条目。
    for (const entry of active) {
      if (!ordered.includes(entry)) failedNames.add(entry.name);
    }
    const failed = this.entries
      .filter((entry) => failedNames.has(entry.name))
      .map((entry) => ({ ...entry, status: "FAILED" as const, failureReason: "HOOK_CYCLE" }));
    return { ordered, failed, cycles };
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
