import type { Disposer } from "@zeta-agent/framework";
import {
  HookChain,
  type HookAddOptions,
  type HookChainOptions,
  type HookCycleFailure,
  type HookEntry,
  type HookFn,
  type HookRunOptions,
} from "./hook-chain";
import type { AgentPlugin } from "./types";

/** 新管线失败时可临时禁用（配置开关），回退到 legacy 字段赋值。 */
export interface PluginPipelineConfig {
  readonly enabled: boolean;
  readonly fallbackToLegacy: boolean;
}

export const DEFAULT_PLUGIN_PIPELINE_CONFIG: PluginPipelineConfig = Object.freeze({
  enabled: true,
  fallbackToLegacy: true,
});

export interface AgentPluginManagerOptions {
  readonly config?: Partial<PluginPipelineConfig>;
  readonly hookChainOptions?: HookChainOptions;
}

/** legacy 字段插件使用最低优先级，作为基线先执行，常规插件随后覆盖。 */
export const LEGACY_FIELD_PRIORITY = Number.MIN_SAFE_INTEGER;

/**
 * 工具权限/安全链专用命名：这些链永远 rethrow，且不参与 legacy 兜底。
 * 普通 hook 的 no-throw 归一化不得在这里变成 fail-open。
 */
export const FAIL_CLOSED_HOOK_CHAINS: readonly string[] = Object.freeze([
  "beforeToolCall",
  "afterToolCall",
  "toolPermission",
]);

export function isFailClosedHookChain(name: string): boolean {
  return FAIL_CLOSED_HOOK_CHAINS.includes(name) || name.startsWith("security:") || name.startsWith("legacy:security:");
}

export type PluginStatus = "ACTIVE" | "FAILED";

/** 调用方可持有的 hook 快照：链名 → 拓扑排序后的活跃条目。 */
export type HookSnapshot = ReadonlyMap<string, readonly HookEntry<unknown>[]>;

export interface PluginStatusRecord {
  readonly plugin: AgentPlugin;
  readonly status: PluginStatus;
  readonly reason?: string;
}

interface MutablePluginStatus {
  plugin: AgentPlugin;
  status: PluginStatus;
  reason?: string;
}

interface ChainOptionsOverride {
  readonly rethrow?: boolean;
}

export interface ManagerRunOptions extends HookRunOptions {
  /** true：禁止 legacy 兜底；链内错误原样上抛，由调用方 fail-closed。 */
  readonly failClosed?: boolean;
  /** 调用方持有的条目快照；在途 run/tool 据此执行旧引用，缺省取当前链快照。 */
  readonly snapshot?: HookSnapshot;
}

/**
 * AgentPlugin 单一管线：所有 hook 注册与执行都经此管理器；
 * legacy 字段赋值被包装为 `legacy:<field>` 插件并纳入同一链条。
 */
export class AgentPluginManager {
  private readonly chains = new Map<string, HookChain<unknown>>();
  private readonly disposers: Array<() => void> = [];
  private readonly legacy = new Map<string, (input: unknown) => unknown>();
  private readonly installed: AgentPlugin[] = [];
  private readonly statuses: MutablePluginStatus[] = [];
  private readonly configValue: PluginPipelineConfig;
  private readonly hookChainOptions: HookChainOptions;

  constructor(options: AgentPluginManagerOptions = {}) {
    this.configValue = { ...DEFAULT_PLUGIN_PIPELINE_CONFIG, ...options.config };
    // 严格模式（禁用 legacy 兜底）保留 rethrow；默认普通 hook 走 no-throw 归一化。
    this.hookChainOptions = {
      rethrow: this.configValue.fallbackToLegacy === false,
      ...options.hookChainOptions,
    };
  }

  get config(): PluginPipelineConfig {
    return this.configValue;
  }

  get installedPlugins(): readonly AgentPlugin[] {
    return [...this.installed];
  }

  get pluginStatuses(): readonly PluginStatusRecord[] {
    return this.statuses.map((record) => ({ ...record }));
  }

  /** 跨链的环检测报告；环内条目已在该链中被隔离为 FAILED。 */
  get cycleReport(): readonly HookCycleFailure[] {
    return [...this.chains.values()].flatMap((chain) => chain.cycles);
  }

  /** 取得（按需创建）命名 hook 链；工具链强制严格，普通链默认 no-throw。 */
  chain<I = unknown>(name: string, override?: ChainOptionsOverride): HookChain<I> {
    let chain = this.chains.get(name);
    if (chain === undefined) {
      const strict = isFailClosedHookChain(name);
      chain = new HookChain<unknown>({
        name,
        ...this.hookChainOptions,
        ...(strict ? { rethrow: true } : {}),
        ...override,
      });
      this.chains.set(name, chain);
    }
    return chain as HookChain<I>;
  }

  /** 注册 hook 并返回幂等 disposer。 */
  addHook<I = unknown>(
    chainName: string,
    fn: HookFn<I>,
    priority?: number,
    name?: string,
    options?: HookAddOptions
  ): Disposer {
    const stop = this.chain<I>(chainName).add(fn, priority, name, options);
    return this.addDisposer(stop);
  }

  /** 把一个 disposer 纳入 LIFO 栈；返回与传入函数身份不同的幂等包装。 */
  addDisposer(dispose: () => void): Disposer {
    let active = true;
    const wrapped = (): void => {
      if (!active) return;
      active = false;
      dispose();
      const index = this.disposers.indexOf(wrapped);
      if (index >= 0) this.disposers.splice(index, 1);
    };
    this.disposers.push(wrapped);
    return wrapped;
  }

  /** 安装插件：调用 install() 并把返回的逆纳入 LIFO 栈。 */
  install(plugin: AgentPlugin): Disposer {
    const dispose = plugin.install();
    this.installed.push(plugin);
    const status: MutablePluginStatus = { plugin, status: "ACTIVE" };
    this.statuses.push(status);
    return this.addDisposer(() => {
      dispose();
      const index = this.installed.indexOf(plugin);
      if (index >= 0) this.installed.splice(index, 1);
      const statusIndex = this.statuses.indexOf(status);
      if (statusIndex >= 0) this.statuses.splice(statusIndex, 1);
    });
  }

  /** 宿主已自行调用 install() 时登记同一插件，使管理器状态与安装事务保持单一语义。 */
  trackInstall(plugin: AgentPlugin): Disposer {
    this.installed.push(plugin);
    const status: MutablePluginStatus = { plugin, status: "ACTIVE" };
    this.statuses.push(status);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const index = this.installed.indexOf(plugin);
      if (index >= 0) this.installed.splice(index, 1);
      const statusIndex = this.statuses.indexOf(status);
      if (statusIndex >= 0) this.statuses.splice(statusIndex, 1);
    };
  }

  /**
   * 插件贡献注册完毕后重算状态：仅把依赖环涉及的目标插件标为 FAILED，
   * 不撤销、不影响其他插件的 hook 链。
   */
  syncPluginStatus(plugin: AgentPlugin): PluginStatusRecord {
    const status = this.statuses.find((record) => record.plugin === plugin);
    if (status === undefined) throw new Error(`PLUGIN_NOT_INSTALLED: ${plugin.name}`);
    const cycles = this.cycleReport.filter((failure) =>
      failure.cycle.some((name) => name === plugin.name || name.startsWith(`${plugin.name}:`))
    );
    status.status = cycles.length > 0 ? "FAILED" : "ACTIVE";
    if (cycles.length > 0) status.reason = `HOOK_CYCLE: ${cycles[0]!.cycle.join(" -> ")}`;
    else delete status.reason;
    return { ...status };
  }

  /** legacy 字段兼容：`agent.prepareRequest = fn` 变为 `legacy:prepareRequest` 插件。 */
  setLegacy(field: string, fn: (input: unknown) => unknown): Disposer {
    this.legacy.set(field, fn);
    const stop = this.addHook<unknown>(field, fn, LEGACY_FIELD_PRIORITY, `legacy:${field}`);
    return () => {
      stop();
      this.legacy.delete(field);
    };
  }

  getLegacy(field: string): ((input: unknown) => unknown) | undefined {
    return this.legacy.get(field);
  }

  /** 捕获当前所有链的活跃条目；在途调用据此执行，后续注册变化不改写旧快照。 */
  snapshot(): HookSnapshot {
    const result = new Map<string, readonly HookEntry<unknown>[]>();
    for (const [name, chain] of this.chains) result.set(name, chain.snapshot());
    return result;
  }

  /**
   * 运行命名链。配置关闭时只走 legacy；普通 hook 默认 no-throw，
   * failClosed 链或严格配置下错误上抛且绝不回退 legacy。
   */
  async run<I>(
    chainName: string,
    input: I,
    signal?: AbortSignal,
    options?: ManagerRunOptions
  ): Promise<I> {
    return this.runSnapshot(chainName, options?.snapshot ?? this.snapshot(), input, signal, options);
  }

  /** 对已捕获快照运行命名链，语义与 run 完全一致。 */
  async runSnapshot<I>(
    chainName: string,
    snapshot: HookSnapshot,
    input: I,
    signal?: AbortSignal,
    options?: ManagerRunOptions
  ): Promise<I> {
    const failClosed = options?.failClosed === true;
    if (!this.configValue.enabled) {
      if (failClosed) throw new Error("PLUGIN_PIPELINE_DISABLED_FAIL_CLOSED");
      return this.runLegacy(chainName, input);
    }
    try {
      const chain = this.chain<I>(chainName, failClosed ? { rethrow: true } : undefined);
      const result = await chain.runWith(
        (snapshot.get(chainName) ?? []) as readonly HookEntry<I>[],
        input,
        signal,
        { reverse: options?.reverse === true }
      );
      // 非严格命名的链若已被 no-throw 创建，failClosed 仍必须阻断（即便没有 in-chain throw）。
      if (failClosed && chain.lastFailures.length > 0) throw chain.lastFailures[0]!.error;
      return result;
    } catch (error) {
      // 工具流水线要求 fail-closed：hook 抛错时不得回退 legacy 赋值后放行。
      if (failClosed || !this.configValue.fallbackToLegacy || isFailClosedHookChain(chainName)) throw error;
      return this.runLegacy(chainName, input);
    }
  }

  /** 逐条目执行命名链（converter 等逐项发射场景），同样经过单一管理器。 */
  async runEach<I>(
    chainName: string,
    input: I,
    signal: AbortSignal | undefined,
    visit: (value: unknown, entry: HookEntry<I>) => void | Promise<void>,
    options?: { readonly snapshot?: HookSnapshot }
  ): Promise<void> {
    return this.runEachSnapshot(chainName, options?.snapshot ?? this.snapshot(), input, signal, visit);
  }

  async runEachSnapshot<I>(
    chainName: string,
    snapshot: HookSnapshot,
    input: I,
    signal: AbortSignal | undefined,
    visit: (value: unknown, entry: HookEntry<I>) => void | Promise<void>
  ): Promise<void> {
    if (!this.configValue.enabled) return;
    await this.chain<I>(chainName).runEachWith(
      (snapshot.get(chainName) ?? []) as readonly HookEntry<I>[],
      input,
      signal,
      visit
    );
  }

  /** LIFO 撤销全部注册。 */
  disposeAll(): void {
    for (const dispose of [...this.disposers].reverse()) dispose();
  }

  clear(): void {
    this.disposeAll();
    this.chains.clear();
    this.legacy.clear();
    this.installed.length = 0;
    this.statuses.length = 0;
  }

  private async runLegacy<I>(chainName: string, input: I): Promise<I> {
    const field = chainName.startsWith("legacy:") ? chainName.slice("legacy:".length) : chainName;
    const fn = this.legacy.get(field);
    if (fn === undefined) return input;
    return (await fn(input)) as I;
  }
}

export function createAgentPluginManager(options?: AgentPluginManagerOptions): AgentPluginManager {
  return new AgentPluginManager(options);
}
