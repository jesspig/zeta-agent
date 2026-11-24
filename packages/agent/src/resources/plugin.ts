import type { Context, Disposer } from "@zeta-agent/framework";
import { RESOURCE_KEY_LIST, resourceKeyFor } from "./keys";
import { RESOURCE_TYPES, type ResourceRegistry, type ResourceType } from "./registry";
import { createResourceWatcher, type WatcherFactory } from "./watch";

export interface ResourcePluginOptions {
  readonly ctx: Context;
  readonly registry: ResourceRegistry;
  /** 需要监听的资源根目录（agent / project）。 */
  readonly roots: readonly string[];
  readonly watcherFactory?: WatcherFactory;
}

export interface ResourcePluginHandle {
  /** 重新扫描并把四类 registry coeffect 重新发布。 */
  refresh(): Promise<void>;
  close(): void;
  readonly generation: number;
}

/**
 * 把 registry 作为四类 coeffect 发布到 fiber context；目录变更经 watcher 触发
 * refresh + notify，依赖方按 target/committed view 自动重激活。所有 provide
 * 都返回 disposer，close 时逆序撤销。
 */
export function installResourcePlugin(options: ResourcePluginOptions): ResourcePluginHandle {
  const { ctx, registry } = options;
  const disposers = new Map<ResourceType, Disposer>();

  function publish(): void {
    const manifest = registry.discover();
    for (const type of RESOURCE_TYPES) {
      disposers.get(type)?.();
      const entries = manifest.entries.filter((entry) => entry.type === type);
      disposers.set(type, ctx.provide(resourceKeyFor(type), entries));
    }
  }

  publish();

  const watcher = createResourceWatcher({
    roots: options.roots,
    ...(options.watcherFactory === undefined ? {} : { watcherFactory: options.watcherFactory }),
    onChange: () => handle.refresh(),
  });

  const handle: ResourcePluginHandle = {
    async refresh() {
      registry.refresh();
      publish();
      await ctx.notify(RESOURCE_KEY_LIST);
    },
    close() {
      watcher.close();
      for (const dispose of [...disposers.values()].reverse()) dispose();
      disposers.clear();
    },
    get generation() {
      return watcher.generation;
    },
  };
  return handle;
}
