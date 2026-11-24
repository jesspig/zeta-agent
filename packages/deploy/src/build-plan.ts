import { assertTarget, targetArch, TARGETS, type TargetId } from "./targets";

export interface LocalBuildPlan {
  readonly target: TargetId;
  readonly bunTarget: string;
  readonly binaryName: string;
  readonly os: "linux" | "darwin" | "win32";
  readonly arch: "x64" | "arm64";
  readonly libc: "glibc" | "musl";
  readonly baseline: boolean;
  readonly assets: readonly string[];
}

/** Bun 的 compile target 命名与部署 target 的显式映射；win32 在 Bun 侧写作 windows。 */
const BUN_OS: Readonly<Record<string, string>> = Object.freeze({
  linux: "linux",
  darwin: "darwin",
  win32: "windows",
});

function createPlan(target: TargetId): LocalBuildPlan {
  const os = target.split("-")[0] as LocalBuildPlan["os"];
  const arch = targetArch(target);
  const libc = target.includes("musl") ? "musl" : "glibc";
  const baseline = target.includes("baseline");
  const bunOs = BUN_OS[os];
  if (bunOs === undefined) throw new Error(`INVALID_TARGET: ${target}`);
  return Object.freeze({
    target,
    bunTarget: `bun-${bunOs}-${arch}${libc === "musl" ? "-musl" : ""}${baseline ? "-baseline" : ""}`,
    binaryName: `zeta-${target}${os === "win32" ? ".exe" : ""}`,
    os,
    arch,
    libc,
    baseline,
    assets: Object.freeze(["arch-marker.zetaasset", "resource-catalog.zetaasset"]),
  });
}

export const LOCAL_BUILD_PLANS: readonly LocalBuildPlan[] = Object.freeze(TARGETS.map(createPlan));

const PLANS_BY_TARGET = new Map<string, LocalBuildPlan>(LOCAL_BUILD_PLANS.map((plan) => [plan.target, plan]));

export function buildPlanFor(target: string): LocalBuildPlan {
  assertTarget(target);
  return PLANS_BY_TARGET.get(target)!;
}

/** 当前宿主的规范 target；未知平台返回 undefined，构建脚本据此跳过不可运行冒烟。 */
export function hostTarget(platform = process.platform, arch = process.arch): string | undefined {
  if (arch !== "x64" && arch !== "arm64") return undefined;
  const candidate = `${platform}-${arch}`;
  return PLANS_BY_TARGET.has(candidate) ? candidate : undefined;
}
