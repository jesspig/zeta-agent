/**
 * RED-15（T-20，本地 fixture，不访问外网）：
 * 六 profile 声明与真实装配一致；local-full 真实 shell 可执行；
 * local 嵌入真实 prompts/skills/schema；插件隔离系统沙箱如实标注平台限制。
 */
const EXPECTED_PROFILES = ["local-safe", "local-full", "daemon", "remote", "research", "multi-tenant"];
const EXPECTED_EMBEDDED = ["arch-marker", "resource-catalog", "system-prompt", "skills-index", "config-schema"];

async function probe() {
  const failures = [];
  const evidence = [];
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const tempRoot = mkdtempSync(join(tmpdir(), "zeta-red15-"));

  const builtins = await import("../../packages/agent/src/assembly/builtins.ts");
  const profiles = [...(builtins.ASSEMBLY_PROFILES ?? [])];
  if (!EXPECTED_PROFILES.every((name) => profiles.includes(name))) {
    failures.push(`ASSEMBLY_PROFILES=${JSON.stringify(profiles)}`);
  } else {
    evidence.push(`profiles=${profiles.join(",")}`);
  }

  const { createDefaultRuntime } = await import("../../packages/agent/src/assembly/runtime.ts");
  const runtime = await createDefaultRuntime({
    profile: "local-full",
    agentRoot: tempRoot,
    sessionStorePath: join(tempRoot, "session.jsonl"),
  });
  try {
    const states = new Map(runtime.manifest.diagnostics.map((item) => [item.id, item.state]));
    if (states.get("tool:bash") !== "active") failures.push(`tool:bash=${states.get("tool:bash")}`);
    else evidence.push("local-full tool:bash=active");

    const shell = runtime.backend?.shell;
    if (shell === undefined) {
      failures.push("runtime.backend.shell 未暴露");
    } else {
      const marker = "RED15_REAL_SHELL_OK";
      const started = await shell.start({
        argv: [process.execPath, "-e", `process.stdout.write(${JSON.stringify(marker)})`],
        cwd: process.cwd(),
      });
      if (!started.ok) {
        failures.push(`shell.start=${started.code}:${started.error}`);
      } else {
        const result = await started.value.exited;
        if (!result.stdout.includes(marker)) failures.push(`shell stdout=${JSON.stringify(result.stdout)}`);
        else evidence.push(`real-shell stdout=${result.stdout}`);
      }
    }
  } finally {
    await runtime.dispose();
  }

  const generated = await import("../../apps/zeta-cli/src/embedded-assets.generated.ts");
  const embeddedIds = (generated.EMBEDDED_MANIFEST?.embedded ?? []).map((item) => item.id);
  const missing = EXPECTED_EMBEDDED.filter((id) => !embeddedIds.includes(id));
  if (missing.length > 0) failures.push(`embedded-missing=${missing.join(",")}`);
  else evidence.push(`embedded=${embeddedIds.join(",")}`);

  const security = await import("../../packages/components/security/src/backend.ts");
  if (typeof security.systemSandboxSupport !== "function") {
    failures.push("systemSandboxSupport 未导出");
  } else {
    const support = security.systemSandboxSupport();
    if (support.state === "active" || support.platformLimited !== true) {
      failures.push(`systemSandbox=${JSON.stringify(support)}`);
    } else {
      evidence.push(`systemSandbox state=${support.state} platform=${support.platform}`);
    }
  }

  rmSync(tempRoot, { recursive: true, force: true });
  return {
    green: failures.length === 0,
    actual: failures.length === 0 ? "六 profile / local-full 真实 shell / 嵌入资源 / 沙箱如实标注全部符合" : failures,
    reason: failures.length === 0 ? "T-20 声明与真实执行一致" : "存在未关闭的实现缺口",
    evidence: evidence.join(" | "),
  };
}

export default {
  id: "RED-15",
  expectation:
    "六 profile 声明与装配一致；local-full 真实 shell 执行；本地嵌入 prompts/skills/schema；无系统沙箱时如实标注平台限制（禁止 synthetic marker 冒充 active）",
  probe,
};
