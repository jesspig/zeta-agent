import { readdirSync, statSync, watch as fsWatch } from "node:fs";
import { join } from "node:path";

export interface WatchHandle {
  close(): void;
}

export type WatcherFactory = (root: string, notify: () => void) => WatchHandle;

export interface ResourceWatcherOptions {
  readonly roots: readonly string[];
  readonly onChange: () => void | Promise<void>;
  /** 注入点：测试可替换真实 fs.watch，生产缺省用 node:fs。 */
  readonly watcherFactory?: WatcherFactory;
}

export interface ResourceWatcher {
  /** 显式检查目录指纹；变化则触发 onChange 并返回 true。 */
  check(): Promise<boolean>;
  close(): void;
  readonly generation: number;
}

function fingerprint(root: string): string {
  const parts: string[] = [];
  function walk(dir: string): void {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        try {
          const stat = statSync(full);
          parts.push(`${full}:${stat.size}:${stat.mtimeMs}`);
        } catch {
          // 文件在扫描中被移除：忽略，下一轮指纹自然会变化。
        }
      }
    }
  }
  walk(root);
  return parts.sort().join("|");
}

const defaultWatcherFactory: WatcherFactory = (root, notify) => {
  let handle: { close(): void } | undefined;
  try {
    handle = fsWatch(root, { recursive: true }, () => notify());
  } catch {
    try {
      handle = fsWatch(root, () => notify());
    } catch {
      handle = undefined;
    }
  }
  return { close: () => handle?.close() };
};

/** 资源目录 watcher：mtime/size 指纹驱动，fs.watch 只负责叫醒 check，测试可同步驱动。 */
export function createResourceWatcher(options: ResourceWatcherOptions): ResourceWatcher {
  const signatures = new Map<string, string>(options.roots.map((root) => [root, fingerprint(root)]));
  let generation = 0;
  let closed = false;
  const handles = options.roots.map((root) =>
    (options.watcherFactory ?? defaultWatcherFactory)(root, () => { void watcher.check(); })
  );

  const watcher: ResourceWatcher = {
    async check() {
      if (closed) return false;
      let changed = false;
      for (const root of options.roots) {
        const next = fingerprint(root);
        if (next !== signatures.get(root)) {
          signatures.set(root, next);
          changed = true;
        }
      }
      if (changed) {
        generation += 1;
        await options.onChange();
      }
      return changed;
    },
    close() {
      if (closed) return;
      closed = true;
      for (const handle of handles) handle.close();
    },
    get generation() {
      return generation;
    },
  };
  return watcher;
}
