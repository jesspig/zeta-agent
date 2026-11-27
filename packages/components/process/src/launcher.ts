import { spawn, type ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { filterProcessEnv } from "./env";
import type { LaunchRequest, LaunchedProcess, ProcessLauncher } from "./types";

function childProcessLauncher(request: LaunchRequest, platform: NodeJS.Platform): LaunchedProcess {
  const [command, ...args] = [request.command, ...request.args];
  if (command.length === 0) throw new Error("PROCESS_LAUNCH_COMMAND_EMPTY");
  const stdio = request.stdio ?? {};
  const child: ChildProcess = spawn(command, [...args], {
    cwd: request.cwd,
    env: filterProcessEnv(request.env ?? {}),
    detached: request.detached ?? platform !== "win32",
    stdio: [
      stdio.stdin === "ignore" ? "ignore" : "pipe",
      stdio.stdout === "ignore" ? "ignore" : "pipe",
      stdio.stderr === "ignore" ? "ignore" : "pipe",
    ],
    ...(request.timeoutMs !== undefined && request.timeoutMs > 0
      ? { timeout: request.timeoutMs, killSignal: request.killSignal ?? ("SIGKILL" as const) }
      : {}),
  });

  let cancelled = false;
  const cancel = async (): Promise<void> => {
    if (cancelled) return;
    cancelled = true;
    if (platform === "win32" && child.pid !== undefined) {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    } else {
      child.kill("SIGTERM");
    }
    await exited;
  };

  const exited = new Promise<number | null>((resolveExit) => {
    child.once("error", () => resolveExit(null));
    child.once("close", (code) => resolveExit(code ?? null));
  });

  return {
    pid: child.pid,
    stdin: {
      write(data) {
        if (child.stdin !== null && !child.stdin.destroyed) child.stdin.write(data);
      },
      end() {
        if (child.stdin !== null && !child.stdin.destroyed) child.stdin.end();
      },
    },
    stdout: (child.stdout ?? new PassThrough()) as AsyncIterable<Uint8Array>,
    stderr: child.stderr === null ? null : (child.stderr as AsyncIterable<Uint8Array>),
    exited,
    kill() {
      try {
        child.kill("SIGKILL");
      } catch {
        // 已退出。
      }
    },
    cancel,
  };
}

export function createNodeProcessLauncher(options: { platform?: NodeJS.Platform } = {}): ProcessLauncher {
  const platform = options.platform ?? process.platform;
  return {
    name: "node",
    confinement: "none",
    launch: (request) => childProcessLauncher(request, platform),
  };
}
