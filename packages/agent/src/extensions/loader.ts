/** 已加载的单个扩展条目。 */
export interface LoadedExtension {
  readonly path: string;
  readonly exports: Record<string, unknown>;
  readonly generation: number;
}

/** 加载失败记录。 */
export interface LoadFailure {
  readonly path: string;
  readonly error: unknown;
}

/** 一次加载/重载的结果快照。 */
export interface LoadResult {
  readonly entries: readonly LoadedExtension[];
  readonly failures: readonly LoadFailure[];
  readonly generation: number;
}

export interface ExtensionLoader {
  /** 首次加载：登记文件路径并求值。 */
  load(paths: readonly string[]): Promise<LoadResult>;
  /** 重新求值上次登记的全部路径；失败项保留旧导出（closure rule）。 */
  reload(): Promise<LoadResult>;
  /** 当前 generation（每次 load/reload 推进一次）。 */
  readonly generation: number;
}

/**
 * 轻量 TS 扩展加载器。
 *
 * 方案选择：用 `Bun.build({ write: false, format: "esm", target: "bun" })` 把 TS 源文件
 * 即时构建为 ESM 字符串，再通过 data URL 动态 import 求值。Bun 原生 TS 支持意味着
 * 等价 jiti「直接加载 TS 源码」的能力，且每次重建都产生全新模块（data URL 内容寻址），
 * 天然绕过模块缓存实现热加载，无需引入 jiti 依赖（偏离说明见交付报告）。
 * 构建错误以异常抛出，交给 reload 的 closure rule 保留旧导出。
 */
export function createExtensionLoader(): ExtensionLoader {
  let generation = 0;
  let registry: readonly string[] = [];
  let entries: readonly LoadedExtension[] = [];
  let failures: readonly LoadFailure[] = [];

  async function evaluate(path: string): Promise<Record<string, unknown>> {
    // 不设 outdir：Bun.build 仅在内存中返回 outputs，不落盘。
    const built = await Bun.build({
      entrypoints: [path],
      format: "esm",
      target: "bun",
    });
    if (!built.success) {
      throw new Error(`BUILD_FAILED: ${built.logs.map((log) => String(log)).join("; ")}`);
    }
    const output = built.outputs[0];
    if (output === undefined) throw new Error("BUILD_FAILED: no output");
    const code = await output.text();
    const url = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
    const loaded = (await import(url)) as Record<string, unknown>;
    const resolved = loaded.default;
    if (typeof resolved === "object" && resolved !== null) {
      return { ...loaded, default: resolved };
    }
    return loaded;
  }

  async function evaluateAll(paths: readonly string[]): Promise<{
    entries: readonly LoadedExtension[];
    failures: readonly LoadFailure[];
  }> {
    const nextEntries: LoadedExtension[] = [];
    const nextFailures: LoadFailure[] = [];
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));

    for (const path of paths) {
      try {
        const exports = await evaluate(path);
        nextEntries.push({ path, exports, generation });
      } catch (error) {
        nextFailures.push({ path, error });
        const previous = byPath.get(path);
        if (previous !== undefined) nextEntries.push(previous);
      }
    }
    return { entries: nextEntries, failures: nextFailures };
  }

  return {
    async load(paths) {
      generation += 1;
      registry = [...paths];
      const result = await evaluateAll(registry);
      entries = result.entries;
      failures = result.failures;
      return { entries, failures, generation };
    },
    async reload() {
      if (registry.length === 0) {
        entries = [];
        failures = [];
        return { entries, failures, generation };
      }
      generation += 1;
      const result = await evaluateAll(registry);
      entries = result.entries;
      failures = result.failures;
      return { entries, failures, generation };
    },
    get generation() {
      return generation;
    },
  };
}
