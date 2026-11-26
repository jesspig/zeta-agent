/**
 * 插件隔离的系统级沙箱支持报告（T-20 / F-T13-01）。
 *
 * 事实：求值在独立子进程 + vm 空 realm 中执行，但子进程本身是普通 OS 进程，
 * 没有 seccomp/jail/微 VM。Windows 平台尤其无可用系统级沙箱。
 * 这里只如实标注，绝不产生 synthetic marker 或把子进程 vm 写成系统级沙箱 active。
 */

export type SandboxState = "active" | "degraded" | "unsupported";

export interface PluginSystemSandbox {
  readonly state: SandboxState;
  readonly platform: NodeJS.Platform;
  readonly platformLimited: boolean;
  readonly mechanism: string | null;
  readonly reason: string;
}

export function pluginSystemSandbox(platform: NodeJS.Platform = process.platform): PluginSystemSandbox {
  if (platform === "win32") {
    return {
      state: "unsupported",
      platform,
      platformLimited: true,
      mechanism: null,
      reason:
        "PLATFORM_LIMITED: Windows 无 seccomp/jail；不可信插件在普通子进程 vm 内求值，宿主 install/hook/工具链仅 trusted 可达，失败关闭",
    };
  }
  return {
    state: "unsupported",
    platform,
    platformLimited: false,
    mechanism: null,
    reason:
      "NO_REAL_SYSTEM_SANDBOX: 未接入 bwrap/seccomp/microvm；不可信插件在普通子进程 vm 内求值，失败关闭",
  };
}
