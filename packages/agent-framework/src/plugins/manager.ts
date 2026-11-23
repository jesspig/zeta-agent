import type { Disposer } from "@zeta-agent/framework";
import { HookChain, type HookChainOptions, type HookFn } from "./hook-chain";
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
 * AgentPlugin 管线：维护按 priority 升序的 hook 数组，每个注册返回 disposer，
 * 全部撤销按 LIFO；legacy 字段赋值被包装为 `legacy:<field>` 插件并纳入同一链条。
 */
export class AgentPluginManager {
  private readonly chains = new Map<string, HookChain<unknown>>();
  private readonly disposers: Array<() => void> = [];
  private readonly legacy = new Map<string, (input: unknown) => unknown>();
  private readonly installed: AgentPlugin[] = [];
  private readonly configValue: PluginPipelineConfig;
  private readonly hookChainOptions: HookChainOptions;

  constructor(options: AgentPluginManagerOptions = {}) {
    this.configValue = { ...DEFAULT_PLUGIN_PIPELINE_CONFIG, ...options.config };
    this.hookChainOptions = { rethrow: true, ...options.hookChainOptions };
  }

  get config(): PluginPipelineConfig {
    return this.configValue;
  }

  get installedPlugins(): readonly AgentPlugin[] {
    return [...this.installed];
  }

  /** 取得（按需创建）命名 hook 链。 */
  chain<I = unknown>(name: string): HookChain<I> {
    let chain = this.chains.get(name);
    if (chain === undefined) {
      chain = new HookChain<unknown>({ name, ...this.hookChainOptions });
      this.chains.set(name, chain);
    }
    return chain as HookChain<I>;
  }

  /** 注册 hook 并返回幂等 disposer。 */
  addHook<I = unknown>(
    chainName: string,
    fn: HookFn<I>,
    priority?: number,
    name?: string
  ): Disposer {
    const stop = this.chain<I>(chainName).add(fn, priority, name);
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
    return this.addDisposer(() => {
      dispose();
      const index = this.installed.indexOf(plugin);
      if (index >= 0) this.installed.splice(index, 1);
    });
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

  /**
   * 运行命名链。配置关闭时只走 legacy 字段赋值；
   * 开启时若 hook 抛错且允许回退，仍以 legacy 赋值兜底。
   */
  async run<I>(chainName: string, input: I, signal?: AbortSignal): Promise<I> {
    if (!this.configValue.enabled) return this.runLegacy(chainName, input);
    try {
      return await this.chain<I>(chainName).run(input, signal);
    } catch (error) {
      if (!this.configValue.fallbackToLegacy) throw error;
      return this.runLegacy(chainName, input);
    }
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
