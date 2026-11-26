/**
 * RED-17（T-23，本地 fixture，不访问外网）：
 * TTY 守卫早于任何 TUI import；headless 全模式不加载 OpenTUI；
 * CLI RPC 走完整 dispatcher（真实 method/错误码，非固定响应）；
 * 真实 PTY 启动 TUI 并验证退出/备用屏/raw 模式（非合成 escape、非 skip）。
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPtyResult, runPtyScenario } from "../../packages/tui/src/pty-real.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const entry = join(root, "apps/zeta-cli/src/index.ts");
const preload = join(root, "apps/zeta-cli/src/__fixtures__/reject-opentui-preload.ts");
const failures = [];
const evidence = [];

function runCli(args, input = "", withPreload = false) {
  const env = { ...process.env };
  delete env.ZETA_BASE_URL;
  delete env.ZETA_API_KEY;
  delete env.ZETA_MODEL;
  const argv = [process.execPath];
  if (withPreload) argv.push("--preload", preload);
  argv.push(entry, ...args);
  return spawnSync(argv[0], argv.slice(1), {
    cwd: root,
    env,
    input,
    encoding: "utf8",
    timeout: 4_000,
  });
}

function probeTtyGuard() {
  const source = readFileSync(entry, "utf8");
  const runTuiAt = source.indexOf("async function runTui");
  const bodyEnd = source.indexOf("const registry = createCommandRegistry()", runTuiAt);
  const section = source.slice(runTuiAt, bodyEnd);
  const guardAt = section.indexOf("非 TTY：请用 zeta");
  const importAt = section.indexOf("loadInteractiveTui()");
  if (guardAt < 0 || importAt < 0 || guardAt > importAt) {
    failures.push(`tty-guard-order: guard@${guardAt} import@${importAt}`);
  }
  for (const args of [["--help"], ["--headless", "hello"], ["--json", "hello"]]) {
    const result = runCli(args, "", true);
    if (result.status !== 0 || result.stderr.includes("HEADLESS_IMPORTED_OPENTUI")) {
      failures.push(`headless-opentui-import: ${args.join(" ")} status=${result.status}`);
    }
  }
  evidence.push(`tty-guard-before-import=${guardAt >= 0 && guardAt < importAt}`);
}

function probeFullRpc() {
  const frames = [
    { jsonrpc: "2.0", id: 1, method: "readiness" },
    { jsonrpc: "2.0", id: 2, method: "configDigest" },
    { jsonrpc: "2.0", id: 3, method: "no.such.method" },
  ];
  const result = runCli(["--rpc"], frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n");
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (result.status !== 0 || lines.length !== 3) {
    failures.push(`rpc-dispatcher: status=${result.status} frames=${lines.length}`);
    return;
  }
  const [ready, digest, unknown] = lines.map((line) => JSON.parse(line));
  if (ready?.id !== 1 || ready?.result !== true) failures.push(`rpc-readiness=${JSON.stringify(ready)}`);
  if (typeof digest?.result !== "string") failures.push(`rpc-configDigest=${JSON.stringify(digest)}`);
  if (unknown?.error?.code !== -32601) failures.push(`rpc-method-not-found=${JSON.stringify(unknown)}`);
  evidence.push(`rpc-methods=${lines.length} unknown-code=${unknown?.error?.code}`);
}

async function probeRealPty() {
  const result = await runPtyScenario("normal", { cwd: root });
  const failuresFromPty = checkPtyResult(result);
  if (failuresFromPty.length > 0) failures.push(`real-pty: ${failuresFromPty.join("；")}`);
  evidence.push(`pty-exit=${result.exitCode} alternate=${result.enteredAlternate}/${result.restoredAlternate} raw=${result.rawModeMarkers}`);
}

async function probe() {
  probeTtyGuard();
  probeFullRpc();
  await probeRealPty();
  return {
    green: failures.length === 0,
    actual: failures.length === 0 ? "TTY 守卫前置 / headless 无 OpenTUI / 完整 RPC / 真实 PTY 全部通过" : failures,
    reason: failures.length === 0 ? "T-23 无合成替代、无 skip 冒充 pass" : "存在 T-23 实现缺口",
    evidence: evidence.join(" | "),
  };
}

export default {
  id: "RED-17",
  expectation:
    "TTY 守卫在任何 TUI import 之前；headless 三模式不加载 OpenTUI；CLI RPC 使用完整 dispatcher；真实 PTY 启动 TUI 并验证退出/备用屏/raw 模式",
  probe,
};
