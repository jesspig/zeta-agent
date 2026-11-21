import { createRuntimePlugin as createCoreRuntimePlugin } from "@opentui/core/runtime-plugin";
import { ensureRuntimePluginSupport as ensureSolidRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support";
import type { SolidRuntimePluginSupportOptions } from "@opentui/solid/runtime-plugin-support";

export type {
  CreateRuntimePluginOptions,
  RuntimeModuleEntry,
  RuntimeModuleLoader,
  RuntimeModuleExports,
  RuntimePluginRewriteOptions,
  RuntimeSpecifierPreserve,
} from "@opentui/core/runtime-plugin";
export type { SolidRuntimePluginSupportOptions } from "@opentui/solid/runtime-plugin-support";

export class RuntimePluginError extends Error {
  readonly code = "PLUGIN_LOAD_FAILED" as const;
  override readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "RuntimePluginError";
    this.cause = cause;
  }
}

export function ensureRuntimePluginSupport(
  options?: SolidRuntimePluginSupportOptions,
): boolean {
  try {
    ensureSolidRuntimePluginSupport(options);
    return true;
  } catch (error) {
    throw new RuntimePluginError("PLUGIN_LOAD_FAILED: 无法启用运行时插件支持", error);
  }
}

export function createRuntimePlugin(
  options?: Parameters<typeof createCoreRuntimePlugin>[0],
): ReturnType<typeof createCoreRuntimePlugin> {
  try {
    return createCoreRuntimePlugin(options);
  } catch (error) {
    throw new RuntimePluginError("PLUGIN_LOAD_FAILED: 无法创建运行时插件", error);
  }
}

export async function loadRuntimePlugin<TModule>(
  path: string,
): Promise<TModule> {
  ensureRuntimePluginSupport();
  try {
    const loaded = (await import(path)) as { default?: TModule } & TModule;
    return (loaded.default ?? loaded) as TModule;
  } catch (error) {
    throw new RuntimePluginError(
      `PLUGIN_LOAD_FAILED: 运行时加载插件失败 (${path})`,
      error,
    );
  }
}
