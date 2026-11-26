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
  type McpToolDescriptor,
  type McpTransportFactory,
} from "./client";
import {
  projectMcpResult,
  promptResultToCallResult,
  resourceResultToCallResult,
  type McpResultSink,
} from "./result-projection";
import {
  isEmissionMcpTool,
  mcpServersKey,
  mcpToolName,
  networkTargetOf,
  type McpServerConfig,
} from "./config";

export * from "./client";
export * from "./config";
export * from "./protocol";
export * from "./transport";
export * from "./result-projection";
export * from "./oauth-grant";
export * from "./oauth-flow";

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
  /** 二进制/资源落盘边界；缺省时遇到二进制内容直接失败关闭。 */
  readonly resultSink?: McpResultSink;
  /** 客户端 roots 列表；仅在显式提供时向 server 声明 roots 能力并注册 roots/list 处理器。 */
  readonly roots?: readonly { readonly uri: string; readonly name?: string }[];
  readonly componentName?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 原始 JSON Schema → provider 可消费的参数表，保留 required 与 description（含 object/array 顶层项）。 */
export function parametersFromInputSchema(schema: unknown): readonly {
  readonly name: string;
  readonly type: "string" | "number" | "boolean" | "object" | "array";
  readonly description: string;
  readonly required?: boolean;
}[] {
  if (!isRecord(schema)) return [];
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  return Object.entries(properties).flatMap(([name, raw]) => {
    if (!isRecord(raw)) return [];
    const type = raw.type === "number" || raw.type === "integer" ? "number"
      : raw.type === "boolean" ? "boolean"
      : raw.type === "string" ? "string"
      : raw.type === "object" ? "object"
      : raw.type === "array" ? "array"
      : undefined;
    if (type === undefined) return [];
    return [{
      name,
      type,
      description: typeof raw.description === "string" ? raw.description : name,
      ...(required.includes(name) ? { required: true } : {}),
    }];
  });
}

export interface McpSnapshot {
  readonly toolNames: readonly string[];
  readonly emissionToolNames: readonly string[];
  readonly connectionCount: number;
  readonly sessions: readonly string[];
  /** 按 advertised capability 注册的 prompts/resources/roots。 */
  readonly promptNames: readonly string[];
  readonly resourceUris: readonly string[];
  readonly rootsRegistered: number;
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
      const promptNames: string[] = [];
      const resourceUris: string[] = [];
      const sessions: string[] = [];
      let rootsRegistered = 0;
      let connectionCount = 0;

      const unwind = async (): Promise<void> => {
        for (const dispose of [...disposers].reverse()) await dispose();
      };
      const mcpToolNames = new Set<string>();
      disposers.push(api.addAfterToolCall(async (event) => {
        const toolEvent = event as Extract<typeof event, { type: "tool_execution_end" }>;
        const name = toolEvent.toolName ?? "";
        if (!mcpToolNames.has(name)) return undefined;
        const projected = await projectMcpResult(toolEvent.result as never, options.resultSink === undefined ? {} : { sink: options.resultSink });
        return {
          content: projected.content,
          ...(projected.structuredContent === undefined ? {} : { structuredContent: projected.structuredContent }),
          ...(projected.details === undefined ? {} : { details: projected.details }),
          ...(projected.isError === undefined ? {} : { isError: projected.isError }),
        };
      }));
      try {
        for (const server of activeServers) {
          const target = networkTargetOf(server);
          if (target !== undefined && !isEgressAllowed(egressPolicy, target)) {
            throw new Error(`EGRESS_DENIED: ${server.name}`);
          }

          const session: McpSession = await openMcpSession(server, backend);
          sessions.push(session.realm);
          const transport = await transportFactory(server, session);
          const connection = await createMcpConnection({
            server,
            transport,
            session,
            handshake: {
              capabilities: options.roots === undefined ? {} : { roots: { listChanged: false } },
            },
          });
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

          const sinkOptions = options.resultSink === undefined ? {} : { sink: options.resultSink };
          /** 单一注册入口：权限门禁 + 工具清单 + 原始 schema 保真，全部走 facade 同一路径。 */
          const declare = (
            name: string,
            description: string,
            parameters: ReturnType<typeof parametersFromInputSchema>,
            inputSchema: unknown,
            outputSchema: unknown,
            execute: (args: Readonly<Record<string, unknown>>) => Promise<unknown>,
            emission: boolean
          ): void => {
            mcpToolNames.add(name);
            toolNames.push(name);
            if (emission) emissionToolNames.push(name);
            if (permissionGate !== undefined) {
              disposers.push(
                permissionGate.declareTools([{ tool: name, stages: [permissionStage] }])
              );
            }
            disposers.push(
              api.registerTool({
                name,
                description,
                parameters,
                ...(inputSchema === undefined ? {} : { inputSchema }),
                ...(outputSchema === undefined ? {} : { outputSchema }),
                execute,
              } as never)
            );
          };
          const advertises = (capability: string): boolean => isRecord(connection.serverCapabilities[capability]);

          // 工具/提示/资源一律按服务器 advertised capability 门控，未声明的能力不注册、不调用。
          if (advertises("tools")) {
            for (const tool of await connection.listTools()) {
              declare(
                mcpToolName(server.name, tool.name),
                tool.description ?? `MCP tool ${tool.name}`,
                parametersFromInputSchema(tool.inputSchema),
                tool.inputSchema,
                tool.outputSchema,
                (args) => connection.callTool(tool.name, args),
                isEmissionMcpTool(tool)
              );
            }
          }
          if (advertises("prompts")) {
            for (const prompt of await connection.listPrompts()) {
              const name = mcpToolName(server.name, `prompt__${prompt.name}`);
              const schema = (prompt as { inputSchema?: unknown; argumentsSchema?: unknown }).inputSchema
                ?? (prompt as { argumentsSchema?: unknown }).argumentsSchema;
              promptNames.push(name);
              declare(
                name,
                prompt.description ?? `MCP prompt ${prompt.name}`,
                parametersFromInputSchema(schema),
                schema,
                undefined,
                async (args) => projectMcpResult(
                  promptResultToCallResult(await connection.getPrompt(prompt.name, args)),
                  sinkOptions
                ),
                false
              );
            }
          }
          if (advertises("resources")) {
            const resources = await connection.listResources();
            for (const [index, resource] of resources.entries()) {
              resourceUris.push(resource.uri);
              declare(
                mcpToolName(server.name, `resource__${index}`),
                resource.description ?? `MCP resource ${resource.name ?? resource.uri}`,
                [],
                undefined,
                undefined,
                async () => projectMcpResult(
                  resourceResultToCallResult(await connection.readResource(resource.uri)),
                  sinkOptions
                ),
                false
              );
            }
          }
          // roots 是客户端能力：显式提供 roots 才在握手声明并注册 server→client 处理器。
          if (options.roots !== undefined && options.roots.length > 0) {
            const roots = options.roots;
            disposers.push(connection.onRequest("roots/list", () => ({ roots })));
            rootsRegistered += 1;
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
        snapshot: { toolNames, emissionToolNames, connectionCount, sessions, promptNames, resourceUris, rootsRegistered },
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
    snapshot: () => currentRuntime?.snapshot ?? {
      toolNames: [], emissionToolNames: [], connectionCount: 0, sessions: [],
      promptNames: [], resourceUris: [], rootsRegistered: 0,
    },
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
