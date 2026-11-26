import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import {
  createHmrController,
  defineComponent,
  type BuildArtifact,
  type Context,
  type ContextFiber,
  type FileSignature,
  type HmrController,
  type HmrResult,
  type HmrState,
  type HmrUnit,
  type SkipReason,
  type UnitInstance,
} from "@zeta-agent/framework";

export interface HotReloadUnit extends HmrUnit {
  /** 原样传给 ctx.use 的组件 config；replace 时不重建 fiber，config 随之保留。 */
  readonly config?: unknown;
  readonly critical?: boolean;
}

export interface PluginHotReloaderOptions<THandle = unknown> {
  readonly ctx: Context;
  /** 真实文件监听根目录；缺省取首个 unit 所在目录。 */
  readonly root?: string;
  /** 安装挂靠的父 fiber；replace 不卸载 fiber，parent 原样保留。 */
  readonly parent?: ContextFiber;
  readonly units?: readonly HotReloadUnit[];
  readonly readFile?: (path: string) => string | Uint8Array | undefined;
  readonly build?: (unit: HmrUnit, version: number, digest: string) => BuildArtifact | Promise<BuildArtifact>;
  readonly evaluate?: (artifact: BuildArtifact) => UnitInstance | Promise<UnitInstance>;
  readonly classify?: (unit: HmrUnit, changed: readonly string[]) => SkipReason | undefined;
  readonly critical?: readonly string[];
  readonly shadowApply?: (unit: HmrUnit, instance: UnitInstance) => void | Promise<void>;
  readonly compensate?: (unit: HmrUnit, previous: HmrState | undefined) => void | Promise<void>;
  /** 每个 unit 的 fiber effect；返回逆供 fiber.update 精确撤销。 */
  readonly effect?: (unit: HotReloadUnit, value: unknown) => (() => void) | void;
  readonly onApply?: (unit: HotReloadUnit, instance: UnitInstance) => void;
  /**
   * 真实插件应用桥：把求值产物安装为新的 AgentPlugin 世代；返回句柄供 revert/discard。
   * 未提供时退化为仅更新 slot/fiber 的值投影（兼容纯数据插件）。
   */
  readonly applyPlugin?: (
    unit: HotReloadUnit,
    instance: UnitInstance,
    previous: THandle | undefined
  ) => THandle | undefined | Promise<THandle | undefined>;
  /** 分区回滚：撤销本次 apply 产生的新世代，恢复旧插件。 */
  readonly revertPlugin?: (unit: HotReloadUnit, applied: THandle) => void | Promise<void>;
  /** 无法回滚时丢弃孤立世代。 */
  readonly discardPlugin?: (handle: THandle) => void | Promise<void>;
  readonly auto?: boolean;
  readonly debounceMs?: number;
}

export interface PluginHotReloader<THandle = unknown> {
  readonly controller: HmrController;
  /** 补偿记录：critical root 与分区回滚均在此可观察。 */
  readonly compensationLog: readonly { readonly id: string; readonly generation: number }[];
  /** 创建 unit fiber 并跑首轮求值；幂等，重复调用只登记新增 unit。 */
  install(units: readonly HotReloadUnit[]): Promise<readonly string[]>;
  markDirty(files: readonly string[]): void;
  markDirtySigned(signatures: readonly FileSignature[]): void;
  flush(): Promise<HmrResult>;
  ready(): Promise<void>;
  failed(): readonly string[];
  revisionOf(id: string): number;
  fiberOf(id: string): ContextFiber | undefined;
  valueOf(id: string): unknown;
  close(): Promise<void>;
}

interface InstalledHandle<THandle> {
  readonly unit: HotReloadUnit;
  readonly fiber: ContextFiber;
  readonly slot: { current: unknown };
  plugin?: THandle;
  pending?: {
    readonly handle: THandle | undefined;
    readonly previous: THandle | undefined;
    revert: boolean;
  };
}

const SOURCE_EXTENSIONS = /\.(ts|tsx|js|mjs|cjs)$/;

/** 从目录发现可热重载的源文件；id 为相对路径（正斜杠），entry 为绝对路径。 */
export function discoverHotReloadUnits(dirs: readonly string[]): readonly HotReloadUnit[] {
  const found = new Map<string, HotReloadUnit>();
  for (const dir of dirs) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !SOURCE_EXTENSIONS.test(entry.name)) continue;
      if (/\.(spec|test)\./.test(entry.name) || entry.name.endsWith(".test-d.ts")) continue;
      const path = join(dir, entry.name);
      const id = relative(dir, path).split(sep).join("/");
      if (!found.has(id)) found.set(id, { id, entry: path });
    }
  }
  return [...found.values()].sort((left, right) => left.id.localeCompare(right.id));
}

/** Bun 内存构建：独立产物 id + digest，绕过 ESM 缓存；不落盘。 */
export async function buildWithBun(
  unit: HmrUnit,
  version: number,
  digest: string
): Promise<BuildArtifact> {
  const built = await Bun.build({
    entrypoints: [unit.entry],
    format: "esm",
    target: "bun",
  });
  if (!built.success) {
    throw new Error(`BUILD_FAILED: ${built.logs.map((log) => String(log)).join("; ")}`);
  }
  const output = built.outputs[0];
  if (output === undefined) throw new Error("BUILD_FAILED: no output");
  const code = await output.text();
  return {
    id: `hmr:${unit.id}:${digest}:${version}`,
    digest,
    version,
    code,
  };
}

/** data URL 求值：每次全新模块实例，旧导出引用不被破坏。 */
export async function evaluateWithBun(artifact: BuildArtifact): Promise<UnitInstance> {
  if (artifact.code === undefined) throw new Error("EVALUATE_FAILED: artifact has no code");
  const url = `data:text/javascript;base64,${Buffer.from(artifact.code).toString("base64")}`;
  const loaded = (await import(url)) as Record<string, unknown>;
  return { artifact: artifact.id, value: loaded.default ?? loaded };
}

function defaultReadFile(path: string): string | Uint8Array | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * 插件热重载器：复用 framework 的 HMR 事务与 Context 的 fiber 生命周期。
 * slot/fiber 保留 uid/parent/config 与宿主会话；传入 applyPlugin 时同时把求值产物
 * 安装为真实 AgentPlugin 世代，工具/hook/section/wrap 随文件变更整体替换。
 */
export function createPluginHotReloader<THandle = unknown>(
  options: PluginHotReloaderOptions<THandle>
): PluginHotReloader<THandle> {
  const handles = new Map<string, InstalledHandle<THandle>>();
  const compensationLog: Array<{ id: string; generation: number }> = [];
  let closed = false;
  const root =
    options.root ??
    (options.units?.[0] === undefined ? process.cwd() : dirname(options.units[0].entry));
  const controller = createHmrController({
    root,
    units: options.units ?? [],
    readFile: options.readFile ?? defaultReadFile,
    build: options.build ?? buildWithBun,
    evaluate: options.evaluate ?? evaluateWithBun,
    classify: options.classify,
    critical: options.critical,
    ...(options.shadowApply === undefined ? {} : { shadowApply: options.shadowApply }),
    compensate: (unit, previous) => {
      const handle = handles.get(unit.id);
      if (handle !== undefined) {
        if (handle.pending !== undefined) handle.pending.revert = true;
        if (previous !== undefined) handle.slot.current = previous.instance.value;
        void handle.fiber.update();
      }
      compensationLog.push({ id: unit.id, generation: previous?.revision ?? 0 });
      options.compensate?.(unit as HotReloadUnit, previous);
    },
    apply: async (unit, instance) => {
      const handle = handles.get(unit.id);
      if (handle === undefined) throw new Error(`HMR_UNIT_NOT_INSTALLED: ${unit.id}`);
      let applied: THandle | undefined;
      if (options.applyPlugin !== undefined) {
        applied = await options.applyPlugin(unit, instance, handle.plugin);
        if (applied !== undefined) {
          handle.pending = { handle: applied, previous: handle.plugin, revert: false };
        }
      }
      handle.slot.current = instance.value;
      options.onApply?.(unit as HotReloadUnit, instance);
      await handle.fiber.update();
    },
    auto: options.auto,
    debounceMs: options.debounceMs,
  });

  /** 事务结束后按 settled/aborted 决定保留还是撤销本次安装的新世代。 */
  async function finalizePending(result: HmrResult): Promise<void> {
    const settled = new Set(result.settled);
    for (const handle of handles.values()) {
      const pending = handle.pending;
      if (pending === undefined) continue;
      handle.pending = undefined;
      if (pending.handle === undefined) continue;
      if (!pending.revert && settled.has(handle.unit.id)) {
        handle.plugin = pending.handle;
        continue;
      }
      handle.plugin = pending.previous;
      if (options.revertPlugin !== undefined && pending.previous !== undefined) {
        await options.revertPlugin(handle.unit, pending.handle);
      } else if (options.discardPlugin !== undefined) {
        await options.discardPlugin(pending.handle);
      }
    }
  }

  return {
    controller,
    get compensationLog() {
      return [...compensationLog];
    },
    async install(units) {
      const ids: string[] = [];
      const initialEntries: string[] = [];
      for (const unit of units) {
        if (handles.has(unit.id)) {
          ids.push(unit.id);
          continue;
        }
        const slot: { current: unknown } = { current: undefined };
        const component = defineComponent({
          name: `hmr:${unit.id}`,
          apply: () => {
            const dispose = slot.current === undefined ? undefined : options.effect?.(unit, slot.current);
            return dispose ?? (() => {});
          },
        });
        const fiber = options.ctx.use(component, unit.config);
        handles.set(unit.id, { unit, fiber, slot });
        ids.push(unit.id);
        if (controller.stateOf(unit.id) === undefined) initialEntries.push(unit.entry);
      }
      if (initialEntries.length > 0) {
        controller.markDirty(initialEntries);
        await finalizePending(await controller.flush());
      }
      await Promise.all(ids.map((id) => handles.get(id)!.fiber.ready));
      return ids;
    },
    markDirty: (files) => controller.markDirty(files),
    markDirtySigned: (signatures) => controller.markDirtySigned(signatures),
    async flush() {
      const result = await controller.flush();
      await finalizePending(result);
      return result;
    },
    ready: () => controller.ready(),
    failed: () => controller.failed(),
    revisionOf: (id) => controller.revisionOf(id),
    fiberOf: (id) => handles.get(id)?.fiber,
    valueOf: (id) => handles.get(id)?.slot.current ?? controller.stateOf(id)?.instance.value,
    async close() {
      if (closed) return;
      closed = true;
      await controller.ready();
      controller.close();
      for (const handle of handles.values()) handle.fiber.remove();
      handles.clear();
    },
  };
}
