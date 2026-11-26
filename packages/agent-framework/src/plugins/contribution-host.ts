import type { Disposer } from "@zeta-agent/framework";
import { DEFAULT_PLUGIN_REALM } from "./registry";
import type { PluginContribution } from "./types";

type ByKind<K extends PluginContribution["kind"]> = Extract<PluginContribution, { kind: K }>;

/** 单项贡献注册时的上下文：顺序、隔离域、世代与替换策略。 */
export interface ContributionContext {
  readonly realm: symbol;
  readonly order: number;
  readonly priority?: number;
  readonly dependsOn?: readonly string[];
  /** 归属插件名前缀，用于把环失败归因到目标插件。 */
  readonly owner?: string;
  readonly generation: number;
  readonly replaceable: boolean;
  readonly required: boolean;
  readonly source: string | undefined;
  readonly digest?: string | undefined;
  readonly capabilities?: readonly string[] | undefined;
  readonly trusted: boolean;
}

/** 六类贡献各自的执行器；由宿主提供真实实现，而非空占位。 */
export interface ContributionExecutors {
  tool(item: ByKind<"tool">, ctx: ContributionContext): Disposer;
  hook(item: ByKind<"hook">, ctx: ContributionContext): Disposer;
  section(item: ByKind<"section">, ctx: ContributionContext): Disposer;
  wrap(item: ByKind<"wrap">, ctx: ContributionContext): Disposer;
  task(item: ByKind<"task">, ctx: ContributionContext): Disposer;
  service(item: ByKind<"service">, ctx: ContributionContext): Disposer;
}

export interface AppliedContribution {
  readonly item: PluginContribution;
  readonly ctx: ContributionContext;
  readonly dispose: Disposer;
}

export interface ContributionHost {
  apply(item: PluginContribution, meta?: Partial<ContributionContext>): Disposer;
  applyAll(items: readonly PluginContribution[], meta?: Partial<ContributionContext>): readonly Disposer[];
  readonly applied: readonly AppliedContribution[];
  readonly generation: number;
  disposeAll(): void;
}

export interface ContributionHostOptions {
  readonly defaultRealm?: symbol;
  readonly generation?: () => number;
}

/**
 * 把声明式贡献翻译为带精确 disposer 的可逆注册。
 * 宿主只需提供六类真实执行器；撤销按 LIFO，单个 disposer 幂等。
 */
export function createContributionHost(
  executors: ContributionExecutors,
  options: ContributionHostOptions = {}
): ContributionHost {
  const defaultRealm = options.defaultRealm ?? DEFAULT_PLUGIN_REALM;
  const nextGeneration = options.generation ?? (() => 0);
  let applied: AppliedContribution[] = [];

  function apply(item: PluginContribution, meta: Partial<ContributionContext> = {}): Disposer {
    const ctx: ContributionContext = {
      realm: meta.realm ?? defaultRealm,
      order: meta.order ?? 100,
      ...(meta.priority === undefined ? {} : { priority: meta.priority }),
      ...(meta.dependsOn === undefined ? {} : { dependsOn: meta.dependsOn }),
      ...(meta.owner === undefined ? {} : { owner: meta.owner }),
      generation: meta.generation ?? nextGeneration(),
      replaceable: meta.replaceable ?? true,
      required: meta.required ?? false,
      source: meta.source,
      ...(meta.digest === undefined ? {} : { digest: meta.digest }),
      ...(meta.capabilities === undefined ? {} : { capabilities: meta.capabilities }),
      trusted: meta.trusted ?? false,
    };
    let dispose: Disposer;
    switch (item.kind) {
      case "tool":
        dispose = executors.tool(item, ctx);
        break;
      case "hook":
        dispose = executors.hook(item, ctx);
        break;
      case "section":
        dispose = executors.section(item, ctx);
        break;
      case "wrap":
        dispose = executors.wrap(item, ctx);
        break;
      case "task":
        dispose = executors.task(item, ctx);
        break;
      case "service":
        dispose = executors.service(item, ctx);
        break;
    }
    const record: AppliedContribution = { item, ctx, dispose };
    applied.push(record);
    let armed = true;
    return () => {
      if (!armed) return;
      armed = false;
      const index = applied.indexOf(record);
      if (index >= 0) applied.splice(index, 1);
      dispose();
    };
  }

  return {
    apply,
    applyAll(items, meta) {
      return items.map((item) => apply(item, meta));
    },
    get applied() {
      return [...applied];
    },
    get generation() {
      return nextGeneration();
    },
    disposeAll() {
      for (const record of [...applied].reverse()) record.dispose();
      applied = [];
    },
  };
}
