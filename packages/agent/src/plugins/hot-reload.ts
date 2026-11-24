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

export interface PluginHotReloaderOptions {
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
  readonly auto?: boolean;
  readonly debounceMs?: number;
}

export interface PluginHotReloader {
  readonly controller: HmrController;
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

interface InstalledHandle {
  readonly unit: HotReloadUnit;
  readonly fiber: ContextFiber;
  readonly slot: { current: unknown };
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
 * replace 只更新组件读取的 slot 并调用 fiber.update()，不 remove/use，
 * 因此 uid、parent、config 与宿主会话全部保留。
 */
export function createPluginHotReloader(options: PluginHotReloaderOptions): PluginHotReloader {
  const handles = new Map<string, InstalledHandle>();
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
        handle.slot.current = previous?.instance.value;
        void handle.fiber.update();
      }
      options.compensate?.(unit as HotReloadUnit, previous);
    },
    apply: async (unit, instance) => {
      const handle = handles.get(unit.id);
      if (handle === undefined) throw new Error(`HMR_UNIT_NOT_INSTALLED: ${unit.id}`);
      handle.slot.current = instance.value;
      options.onApply?.(unit as HotReloadUnit, instance);
      await handle.fiber.update();
    },
    auto: options.auto,
    debounceMs: options.debounceMs,
  });

  return {
    controller,
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
        await controller.flush();
      }
      await Promise.all(ids.map((id) => handles.get(id)!.fiber.ready));
      return ids;
    },
    markDirty: (files) => controller.markDirty(files),
    markDirtySigned: (signatures) => controller.markDirtySigned(signatures),
    flush: () => controller.flush(),
    ready: () => controller.ready(),
    failed: () => controller.failed(),
    revisionOf: (id) => controller.revisionOf(id),
    fiberOf: (id) => handles.get(id)?.fiber,
    valueOf: (id) => handles.get(id)?.slot.current ?? controller.stateOf(id)?.instance.value,
    async close() {
      controller.close();
      for (const handle of handles.values()) handle.fiber.remove();
      handles.clear();
    },
  };
}
