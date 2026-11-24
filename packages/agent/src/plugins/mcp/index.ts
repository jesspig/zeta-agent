import {
  defineComponent,
  type Context,
  type ContextFiber,
  type CoeffectKey,
  type Disposer,
} from "@zeta-agent/framework";
import { createEgressPolicy, isEgressAllowed, type EgressPolicy, type ExecutionBackend } from "@zeta-agent/security";
import type { PluginApiSurface } from "../../facade";
import type { PermissionGate } from "../permissions/guard";
import {
  createMcpConnection,
  openMcpSession,
  type McpSession,
  type McpTransportFactory,
} from "./client";
import {
  isEmissionMcpTool,
  mcpServersKey,
  mcpToolName,
  networkTargetOf,
  type McpServerConfig,
} from "./config";

export * from "./client";
export * from "./config";

export interface McpPluginOptions {
  /** facade 插件 API：工具注册、发射工具声明都经由它，保持单一执行路径。 */
  readonly api: PluginApiSurface;
  /** 完整 fiber 上下文：提供 mcpServersKey 并驱动依赖方重激活。 */
  readonly ctx: Context;
  /** stdio/socket 必须经该后端会话绑定；能力降级即失败关闭。 */
  readonly backend: ExecutionBackend;
  /** 字节通道注入点；插件自身不内置进程/网络实现。 */
  readonly transportFactory: McpTransportFactory;
  readonly servers: readonly McpServerConfig[];
  /** 缺省为默认拒绝策略，网络型 server 未获 allow 即不连接。 */
  readonly egressPolicy?: EgressPolicy;
  /** 注入后 MCP 工具纳入权限门禁的 stage 声明，调用统一经 facade 的 authorize。 */
  readonly permissionGate?: PermissionGate;
  readonly permissionStage?: string;
  /** 缺省 ctx.notify；可注入以观察重激活通知。 */
  readonly notify?: (keys: readonly CoeffectKey<any>[]) => Promise<void>;
  readonly componentName?: string;
}

export interface McpSnapshot {
  readonly toolNames: readonly string[];
  readonly emissionToolNames: readonly string[];
  readonly connectionCount: number;
  readonly sessions: readonly string[];
}

export interface McpPluginHandle {
  readonly fiber: ContextFiber;
  /** 等待首次（或最近一次）安装完成。 */
  readonly ready: Promise<void>;
  setServers(servers: readonly McpServerConfig[]): Promise<void>;
  refresh(): Promise<void>;
  snapshot(): McpSnapshot;
  dispose(): Promise<void>;
}

interface Runtime {
  readonly snapshot: McpSnapshot;
  dispose(): Promise<void>;
}

/**
 * 安装 MCP 插件：server 配置声明为 mcpServersKey coeffect；注入该键的 fiber 在
 * tools/list_changed 或配置变更时重激活，工具经 api.registerTool 同名替换注册，
 * 连接句柄纳入 ctx.effect 随 fiber/context 卸载关闭。
 */
export function installMcpPlugin(options: McpPluginOptions): McpPluginHandle {
  const {
    api,
    ctx,
    backend,
    transportFactory,
    egressPolicy = createEgressPolicy(),
    permissionGate,
    permissionStage = "plan",
  } = options;
  let fiberRef: ContextFiber | undefined;
  // notify 表达 coeffect 依赖（并刷新其他注入方）；工具清单变化不改变 provider 视图 uid，
  // 因此对宿主 fiber 额外 update 以强制重激活。
  const notify = async (keys: readonly CoeffectKey<any>[]): Promise<void> => {
    if (options.notify !== undefined) await options.notify(keys);
    else await ctx.notify(keys);
    await fiberRef?.update();
  };
  let servers = [...options.servers];
  let stopProviding: Disposer | undefined = ctx.provide(mcpServersKey, servers);
  let currentRuntime: Runtime | undefined;

  const component = defineComponent({
    name: options.componentName ?? "mcp:plugin",
    inject: [mcpServersKey],
    apply: async (fiberCtx) => {
      // 显式回收上一代运行时：refresh 路径的逆由各 disposer 自身保证幂等。
      const previous = currentRuntime;
      currentRuntime = undefined;
      if (previous !== undefined) await previous.dispose();

      const activeServers = fiberCtx.get(mcpServersKey);
      const disposers: Disposer[] = [];
      const toolNames: string[] = [];
      const emissionToolNames: string[] = [];
      const sessions: string[] = [];
      let connectionCount = 0;

      const unwind = async (): Promise<void> => {
        for (const dispose of [...disposers].reverse()) await dispose();
      };

      try {
        for (const server of activeServers) {
          const target = networkTargetOf(server);
          if (target !== undefined && !isEgressAllowed(egressPolicy, target)) {
            throw new Error(`EGRESS_DENIED: ${server.name}`);
          }

          const session: McpSession = await openMcpSession(server, backend);
          sessions.push(session.realm);
          const transport = await transportFactory(server, session);
          const connection = await createMcpConnection({ server, transport, session });
          connectionCount += 1;

          // 连接句柄纳入 ctx.effect：fiber/context 卸载时由宿主关闭。
          disposers.push(
            fiberCtx.effect(() => () => connection.dispose(), `mcp:${server.name}:connection`)
          );
          disposers.push(
            connection.onToolsChanged(() => {
              return notify([mcpServersKey]);
            })
          );

          for (const tool of await connection.listTools()) {
            const name = mcpToolName(server.name, tool.name);
            toolNames.push(name);
            if (isEmissionMcpTool(tool)) emissionToolNames.push(name);

            if (permissionGate !== undefined) {
              disposers.push(
                permissionGate.declareTools([{ tool: name, stages: [permissionStage] }])
              );
            }
            disposers.push(
              api.registerTool({
                name,
                description: tool.description ?? `MCP tool ${tool.name}`,
                parameters: [],
                execute: (args: Readonly<Record<string, unknown>>) => connection.callTool(tool.name, args),
              } as never)
            );
          }
        }
      } catch (error) {
        await unwind();
        throw error;
      }

      if (emissionToolNames.length > 0) {
        disposers.push(api.declareEmissionTools(emissionToolNames));
      }

      const runtime: Runtime = {
        snapshot: { toolNames, emissionToolNames, connectionCount, sessions },
        dispose: unwind,
      };
      currentRuntime = runtime;
      return unwind;
    },
  });

  const fiber = ctx.use(component);
  fiberRef = fiber;
  // provider fiber 异步激活；先排空在途装载并通知注入方，确保首次 apply 真正运行。
  const ready = (async () => {
    await ctx.notify([mcpServersKey]);
    await fiber.ready;
  })();

  return {
    fiber,
    ready,
    async setServers(next) {
      servers = [...next];
      stopProviding?.();
      stopProviding = ctx.provide(mcpServersKey, servers);
      await notify([mcpServersKey]);
    },
    refresh: async () => {
      await notify([mcpServersKey]);
    },
    snapshot: () => currentRuntime?.snapshot ?? { toolNames: [], emissionToolNames: [], connectionCount: 0, sessions: [] },
    async dispose() {
      const runtime = currentRuntime;
      currentRuntime = undefined;
      if (runtime !== undefined) await runtime.dispose();
      fiber.remove();
      stopProviding?.();
      stopProviding = undefined;
    },
  };
}
