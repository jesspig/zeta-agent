import type { Disposer } from "../types";

/**
 * staging 事务可安装的最小形状。用结构化类型而非 agent-framework 的 AgentPlugin，
 * 避免 framework 反向依赖上层包；AgentPlugin 天然满足该形状。
 */
export interface StagedInstallable {
  readonly name: string;
  install(): Disposer;
}

/** 安装元数据：来源、摘要、能力、顺序、隔离域与替换策略。 */
export interface StageMeta {
  readonly name?: string;
  readonly realm?: symbol;
  readonly order?: number;
  readonly replaceable?: boolean;
  readonly required?: boolean;
  readonly source?: string;
  readonly digest?: string;
  readonly capabilities?: readonly string[];
  readonly trusted?: boolean;
}

export interface StagedEntry<T extends StagedInstallable> {
  readonly item: T;
  readonly meta: StageMeta;
  readonly name: string;
  readonly generation: number;
  readonly order: number;
  readonly realm: symbol | undefined;
  readonly replaceable: boolean;
  readonly required: boolean;
  readonly source: string | undefined;
  readonly digest: string | undefined;
  readonly capabilities: readonly string[];
  readonly trusted: boolean;
}

export interface StageInput<T extends StagedInstallable> {
  readonly item: T;
  readonly meta?: StageMeta;
}

/** 记录 install() 原样返回的 disposer，撤销时不能用包装后的版本替代。 */
export interface PluginInstallRecord<T extends StagedInstallable> {
  readonly entry: StagedEntry<T>;
  readonly dispose: Disposer;
}

export interface ValidationIssue<T extends StagedInstallable> {
  readonly entry: StagedEntry<T>;
  readonly reason: string;
}

export type ValidateRule<T extends StagedInstallable> = (entry: StagedEntry<T>) => string | undefined;

export interface CommitHandlers<T extends StagedInstallable> {
  /** 默认调用 entry.item.install()；可注入以审计/包装，但返回值仍原样记录。 */
  readonly install?: (entry: StagedEntry<T>) => Disposer;
  /** 真实注册入口：把 install 产物接入执行器；抛错即触发整体回滚。 */
  readonly apply: (entry: StagedEntry<T>, record: PluginInstallRecord<T>) => void;
  /** 回滚时先撤销注册，再调用 install() 的原样 disposer。 */
  readonly unapply?: (entry: StagedEntry<T>, record: PluginInstallRecord<T>) => void;
}

export interface CommitResult<T extends StagedInstallable> {
  readonly installed: readonly PluginInstallRecord<T>[];
  readonly rolledBack: readonly PluginInstallRecord<T>[];
  readonly stale: readonly StagedEntry<T>[];
  readonly error?: unknown;
  readonly generation: number;
}

export interface PluginTransaction<T extends StagedInstallable> {
  /** 仅登记，不产生副作用；generation 在 stage 时固定。 */
  stage(inputs: readonly StageInput<T>[]): readonly StagedEntry<T>[];
  readonly staged: readonly StagedEntry<T>[];
  validate(rules?: readonly ValidateRule<T>[]): readonly ValidationIssue<T>[];
  commit(handlers: CommitHandlers<T>): CommitResult<T>;
  /** 丢弃暂存，不安装任何插件。 */
  discard(): void;
  readonly generation: number;
}

export interface PluginTransactionOptions {
  readonly generation?: () => number;
}

function defaultRules<T extends StagedInstallable>(): readonly ValidateRule<T>[] {
  return [
    (entry) =>
      typeof entry.name === "string" && entry.name.length > 0 ? undefined : "NAME_REQUIRED",
    (entry) => (typeof entry.item.install === "function" ? undefined : "INSTALL_REQUIRED"),
  ];
}

/**
 * 插件安装事务：staging → validate → commit，任一步失败即 discard。
 * - install() 的原样 disposer 逐插件记录，回滚按 LIFO 精确撤销。
 * - 晚到的旧 generation 暂存项在 commit 时跳过，不覆盖新世代状态。
 */
export function createPluginTransaction<T extends StagedInstallable>(
  options: PluginTransactionOptions = {}
): PluginTransaction<T> {
  const nextGeneration = options.generation ?? (() => 0);
  let staged: StagedEntry<T>[] = [];

  function toEntry(input: StageInput<T>, generation: number): StagedEntry<T> {
    const meta = input.meta ?? {};
    return {
      item: input.item,
      meta,
      name: meta.name ?? input.item.name,
      generation,
      order: meta.order ?? 100,
      realm: meta.realm,
      replaceable: meta.replaceable ?? true,
      required: meta.required ?? false,
      source: meta.source,
      digest: meta.digest,
      capabilities: meta.capabilities ?? [],
      trusted: meta.trusted ?? false,
    };
  }

  return {
    stage(inputs) {
      const generation = nextGeneration();
      const entries = inputs.map((input) => toEntry(input, generation));
      staged.push(...entries);
      return entries;
    },
    get staged() {
      return [...staged];
    },
    validate(rules = defaultRules<T>()) {
      const issues: ValidationIssue<T>[] = [];
      for (const entry of staged) {
        for (const rule of rules) {
          const reason = rule(entry);
          if (reason !== undefined) issues.push({ entry, reason });
        }
      }
      return issues;
    },
    commit(handlers) {
      const generation = nextGeneration();
      const fresh = staged
        .filter((entry) => entry.generation === generation)
        .slice()
        .sort((left, right) => left.order - right.order);
      const stale = staged.filter((entry) => entry.generation !== generation);
      staged = [];

      const installed: PluginInstallRecord<T>[] = [];
      const rollback = (error: unknown): CommitResult<T> => {
        const rolledBack: PluginInstallRecord<T>[] = [];
        for (const record of [...installed].reverse()) {
          handlers.unapply?.(record.entry, record);
          record.dispose();
          rolledBack.push(record);
        }
        return { installed: [], rolledBack, stale, error, generation };
      };

      for (const entry of fresh) {
        try {
          const dispose = handlers.install?.(entry) ?? entry.item.install();
          const record: PluginInstallRecord<T> = { entry, dispose };
          // 先入账再 apply：apply 失败时本次 install() 也必须在回滚范围内。
          installed.push(record);
          handlers.apply(entry, record);
        } catch (error) {
          return rollback(error);
        }
      }
      return { installed, rolledBack: [], stale, generation };
    },
    discard() {
      staged = [];
    },
    get generation() {
      return nextGeneration();
    },
  };
}

/**
 * 按 Map 中的 value 身份删除：旧 disposer 晚到时不会误删同名的新条目。
 * 这是同名工具替换与 generation 失效共用的最小原语。
 */
export function identityDisposer<K, V>(map: Map<K, V>, key: K, value: V): Disposer {
  let armed = true;
  return () => {
    if (!armed) return;
    armed = false;
    if (map.get(key) === value) map.delete(key);
  };
}
