/**
 * T-24 / F-T13-01：系统级沙箱可行性权威探针（只记录事实，不授予能力）。
 *
 * 关键结论保持 unsupported/platformLimited：进程内无系统沙箱 API、无 native addon、
 * Windows Job Object 只能经 PowerShell 进程外 P/Invoke 且不构成 fs/network 隔离、
 * AppContainer 需打包身份、宿主无 Linux seccomp/bwrap runner。
 * 探针只输出可复核布尔值与稳定原因码，不含绝对路径/密钥。
 */
import * as childProcess from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostTarget } from "../packages/deploy/src/index.ts";

const { spawnSync } = childProcess;

const JOB_PS1 = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ZetaJobProbe {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr CreateJobObject(IntPtr a, string name);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr h);
}
'@
$ErrorActionPreference = 'Stop'
$h = [ZetaJobProbe]::CreateJobObject([IntPtr]::Zero, $null)
if ($h -eq [IntPtr]::Zero) { Write-Output 'JOB_OBJECT=unavailable' } else { Write-Output 'JOB_OBJECT=reachable'; [void][ZetaJobProbe]::CloseHandle($h) }
`;

function countNativeAddons(root, maxDepth = 4) {
  let count = 0;
  const walk = (dir, depth) => {
    if (depth > maxDepth || !existsSync(dir)) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.endsWith(".node")) count += 1;
      else if (entry.isDirectory() && entry.name !== ".git" && entry.name !== ".cache") {
        walk(join(dir, entry.name), depth + 1);
      }
    }
  };
  walk(join(root, "node_modules"), 0);
  return count;
}

function commandAvailable(name) {
  const finder = process.platform === "win32" ? "where.exe" : "where";
  try {
    const result = spawnSync(finder, [name], { encoding: "utf8", shell: false, timeout: 5_000 });
    return result.status === 0;
  } catch {
    return false;
  }
}

/** WSL 在 Windows 上以 UTF-16LE 输出；只统计发行版数量，不输出本地路径或用户名。 */
function wslDistroCount() {
  if (process.platform !== "win32") return 0;
  try {
    const result = spawnSync("wsl.exe", ["--list", "--quiet"], { encoding: "buffer", shell: false, timeout: 15_000 });
    if (result.status !== 0) return 0;
    const text = Buffer.from(result.stdout ?? []).toString("utf16le");
    return text
      .split(/\r?\n/)
      .map((line) => line.replace(/\0/g, "").trim())
      .filter((line) => line.length > 0).length;
  } catch {
    return 0;
  }
}

function probePowerShellPInvoke() {
  if (process.platform !== "win32") return { reachable: false, detail: "non-windows-host" };
  const path = join(tmpdir(), `zeta-job-probe-${randomBytes(6).toString("hex")}.ps1`);
  try {
    writeFileSync(path, JOB_PS1, "utf8");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path], {
      encoding: "utf8",
      shell: false,
      timeout: 30_000,
    });
    const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    return {
      reachable: result.status === 0 && out.includes("JOB_OBJECT=reachable"),
      detail: result.status === 0 && out.includes("JOB_OBJECT=reachable") ? "out-of-process-only" : "unavailable",
    };
  } catch (error) {
    return { reachable: false, detail: `probe-error:${error instanceof Error ? error.message : String(error)}` };
  } finally {
    try {
      rmSync(path, { force: true });
    } catch {
      // 临时脚本清理失败不影响结论。
    }
  }
}

export function probeSandboxFeasibility(root, options = {}) {
  const target = options.hostTarget ?? hostTarget() ?? "unknown";
  const nativeAddons = countNativeAddons(root);
  const jobPowerShell = options.jobPowerShell ?? probePowerShellPInvoke();
  const inProcessApi = options.inProcessApi ?? {
    childProcess: "createJobObject" in childProcess,
    global: "JobObject" in globalThis,
  };
  const runners = options.runners ?? {
    wsl: commandAvailable("wsl.exe"),
    bwrap: commandAvailable("bwrap"),
    seccomp: commandAvailable("seccomp-tools"),
  };
  const wslDistros = options.wslDistros ?? wslDistroCount();
  const packagedIdentity =
    options.packagedIdentity ??
    (process.platform === "win32" && typeof process.env.AppxPackageFamilyName === "string");
  const platformLimited = process.platform === "win32";

  return {
    schema: "zeta-sandbox-feasibility/1",
    generatedAt: options.now?.() ?? new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch, target },
    state: "unsupported",
    platformLimited,
    closure: "unmet",
    evidence: {
      inProcessJobObjectApi: inProcessApi,
      nativeAddonCount: nativeAddons,
      jobObjectViaOutOfProcessPowerShell: jobPowerShell,
      appContainerPackagedIdentity: packagedIdentity,
      linuxRunner: runners,
      wslDistroCount: wslDistros,
    },
    reasons: [
      "NO_IN_PROCESS_SYSTEM_SANDBOX_API: Node/Bun 与 @zeta-agent/components 无进程内 Job Object/seccomp 绑定",
      `NO_NATIVE_ADDON: node_modules 中 .node 原生模块数=${nativeAddons}，无可用 native addon`,
      jobPowerShell.reachable
        ? "OUT_OF_PROCESS_ONLY: Job Object 仅能经 PowerShell 进程外 P/Invoke 到达，需新增第二条平台专属执行路径，且 Job Object 不限制 fs/network，不能据此声明完整系统级沙箱 active"
        : "JOB_OBJECT_UNREACHABLE: 进程外 P/Invoke 也不可用",
      packagedIdentity
        ? "APPcontainer_IDENTITY_PRESENT"
        : "NO_APP_CONTAINER_IDENTITY: 当前 CLI 非打包应用，无 AppContainer 所需包身份/能力声明",
      runners.wsl
        ? `WSL_RUNNER_PRESENT_BUT_NOT_HOST_PRODUCTION_PATH: WSL 发行版数=${wslDistros}；当前宿主 target=${target} 的生产路径在 Windows 进程内，将 WSL seccomp/bwrap 接入会形成第二条平台专属执行路径，违反 CONSTITUTION「生产路径唯一」，且 RED-15/F-T13-01 约束要求维持 platformLimited；交 T-25 独立验收`
        : runners.bwrap
          ? "BWRAP_RUNNER_MAY_EXIST: 需另行核验 seccomp 可用性与生产路径唯一性"
          : "NO_LINUX_RUNNER: 宿主无 WSL/bwrap/seccomp runner，无法验证 Linux seccomp/bwrap 路径",
      "CONSTRAINT: CONSTITUTION 要求生产路径唯一；不得用合成 marker 或子进程 vm 冒充系统级沙箱",
    ],
    disposition:
      "维持 F-T13-01 为未关闭项：systemSandbox/isolation = unsupported + platformLimited，失败关闭；交 T-25 如实列出，禁止写 active/pass",
  };
}

function render(report) {
  const e = report.evidence;
  return [
    "# F-T13-01 系统级沙箱可行性证据（T-24）",
    "",
    `- Schema：\`${report.schema}\``,
    `- 生成时间：${report.generatedAt}`,
    `- 宿主：${report.host.platform}/${report.host.arch}（target=${report.host.target}）`,
    `- 结论：**${report.state} / platformLimited=${report.platformLimited} / closure=${report.closure}**`,
    "",
    "| 探针 | 结果 |",
    "| --- | --- |",
    `| 进程内 Job Object API | ${e.inProcessJobObjectApi.childProcess || e.inProcessJobObjectApi.global ? "存在" : "缺失"} |`,
    `| native addon 数量 | ${e.nativeAddonCount} |`,
    `| Job Object 经 PowerShell 进程外 P/Invoke | ${e.jobObjectViaOutOfProcessPowerShell.reachable ? "可达（仅进程外）" : "不可达"} |`,
    `| AppContainer 打包身份 | ${e.appContainerPackagedIdentity ? "存在" : "缺失"} |`,
    `| Linux runner (wsl/bwrap/seccomp-tools) | ${JSON.stringify(e.linuxRunner)} |`,
    `| WSL 发行版数量 | ${e.wslDistroCount} |`,
    "",
    "## 原因码",
    "",
    ...report.reasons.map((reason) => `- ${reason}`),
    "",
    `## 处置`,
    "",
    report.disposition,
    "",
  ].join("\n");
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const report = probeSandboxFeasibility(root);
  const { mkdirSync, writeFileSync: writeText } = await import("node:fs");
  const reports = join(root, "reports");
  mkdirSync(reports, { recursive: true });
  writeText(join(reports, "sandbox-feasibility.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeText(join(reports, "sandbox-feasibility.md"), render(report), "utf8");
  console.log(
    `sandbox-feasibility: state=${report.state} platformLimited=${report.platformLimited} closure=${report.closure} target=${report.host.target}`
  );
  for (const reason of report.reasons) console.log(`  - ${reason}`);
  console.log(report.disposition);
  process.exit(0);
}
