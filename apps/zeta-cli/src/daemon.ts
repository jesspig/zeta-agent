import type { RuntimeProtocol } from "@zeta-agent/agent";
import {
  createMemorySessionControl,
  createStdoutWriter,
  hostTarget,
  startDaemon,
  type DaemonHandle,
  type DaemonTlsConfig,
  type DeployConfig,
  type RpcRuntime,
  type StdoutWriter,
} from "@zeta-agent/deploy";
import type { CliArgs } from "./args";

/** CLI 装配提供给控制面的最小 seam：T-10 protocol + T-20 探针。 */
export interface CliDaemonBundle {
  readonly runtime: { readonly protocol: RuntimeProtocol };
  readonly probes: {
    readiness(): boolean;
    liveness(): boolean;
    configDigest(): string;
  };
}

export function createCliRpcRuntime(bundle: CliDaemonBundle): RpcRuntime {
  return {
    protocol: bundle.runtime.protocol,
    probes: bundle.probes,
    session: createMemorySessionControl(),
  };
}

export interface CliDaemonOptions {
  readonly port?: number;
  readonly ipcPort?: number;
  readonly token?: string;
  readonly writer?: StdoutWriter;
  readonly runtimeFactory?: () => RpcRuntime;
  readonly autoRestart?: boolean;
  readonly leaseTtlMs?: number;
  readonly heartbeatMs?: number;
  readonly tls?: DaemonTlsConfig;
  /** CLI 是显式开发入口：loopback 明文必须在这里显式开启。 */
  readonly allowPlainLoopback?: boolean;
}

export function startCliDaemon(
  args: CliArgs,
  bundle: CliDaemonBundle,
  options: CliDaemonOptions = {}
): DaemonHandle {
  const token = options.token ?? args.token ?? process.env.ZETA_DAEMON_TOKEN;
  if (typeof token !== "string" || token.length === 0) throw new Error("DAEMON_TOKEN_REQUIRED");
  const config: DeployConfig = { target: hostTarget() ?? "linux-x64" };
  return startDaemon({
    token,
    config,
    runtime: createCliRpcRuntime(bundle),
    runtimeFactory: options.runtimeFactory ?? (() => createCliRpcRuntime(bundle)),
    autoRestart: options.autoRestart ?? true,
    leaseTtlMs: options.leaseTtlMs,
    heartbeatMs: options.heartbeatMs,
    tls: options.tls,
    allowPlainLoopback: options.allowPlainLoopback ?? true,
    port: options.port ?? 0,
    ipcPort: options.ipcPort ?? 0,
    writer: options.writer,
  });
}

/** 进程入口：daemon 保持前台，收到退出信号后先排空再停服。 */
export async function runDaemonMode(args: CliArgs, bundle: CliDaemonBundle): Promise<number> {
  const writer = createStdoutWriter({
    write: (chunk) => process.stdout.write(chunk) !== false,
    diagnostic: (line) => {
      process.stderr.write(`${line}\n`);
    },
  });
  const handle = startCliDaemon(args, bundle, { writer });
  writer.diagnostic(`daemon http ${handle.url} ipc ${handle.ipcPort} generation ${handle.generation}`);
  await new Promise<void>((resolve) => {
    const stop = (): void => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await handle.stop();
  await writer.close();
  return 0;
}
