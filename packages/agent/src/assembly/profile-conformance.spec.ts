import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ASSEMBLY_PROFILES,
  builtinIdsForProfile,
  type AssemblyProfile,
} from "./builtins";
import { createDefaultRuntime } from "./runtime";
import { policyForProfile } from "./profile-policy";

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "zeta-t20-profile-"));
  mkdirSync(join(root, "skills"), { recursive: true });
  mkdirSync(join(root, "prompts"), { recursive: true });
  return root;
}

async function boot(profile: AssemblyProfile, root: string) {
  return createDefaultRuntime({
    profile,
    agentRoot: root,
    projectRoot: join(root, "project"),
    sessionStorePath: join(root, "session.jsonl"),
    ...(profile === "multi-tenant"
      ? { principalInput: { spaceId: "space-1", userId: "user-1" } }
      : {}),
  });
}

describe("T-20 六 profile conformance：声明与真实装配一一对应", () => {
  test("六个 profile 的 manifest、builtin、服务注入与后端能力全部一致", async () => {
    expect(ASSEMBLY_PROFILES).toHaveLength(6);
    for (const profile of ASSEMBLY_PROFILES) {
      const root = tempRoot();
      const runtime = await boot(profile, root);
      try {
        const policy = policyForProfile(profile);
        expect(runtime.manifest.profile).toBe(profile);
        expect([...runtime.manifest.plugins].sort()).toEqual([...builtinIdsForProfile(profile)].sort());
        expect(runtime.backend.name).toBe(policy.backend);

        const states = new Map(runtime.manifest.diagnostics.map((item) => [item.id, item.state]));
        expect(states.get(`profile:${profile}`)).toBe("active");
        expect(runtime.manifest.diagnostics.some((item) => item.id === "research:seal")).toBe(
          profile === "research"
        );
        expect(states.get("tool:bash")).toBe(policy.shell ? "active" : "unsupported");

        for (const name of runtime.manifest.services) {
          expect(runtime.services[name], `${profile}:${name}`).toBeDefined();
        }
        expect(runtime.sessionStore).toBeDefined();
        expect(runtime.resourceWatcher !== undefined).toBe(policy.resourceWatcher);
        if (policy.resourceWatcher) {
          expect(typeof (runtime.resourceWatcher as { refresh?: unknown }).refresh).toBe("function");
        }
      } finally {
        await runtime.dispose();
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("local-safe 保持收敛：默认无持久会话、无资源 watcher、shell 失败关闭", async () => {
    const root = tempRoot();
    const runtime = await createDefaultRuntime({ profile: "local-safe", agentRoot: root, projectRoot: root });
    try {
      expect(runtime.sessionStore).toBeUndefined();
      expect(runtime.resourceWatcher).toBeUndefined();
      const states = new Map(runtime.manifest.diagnostics.map((item) => [item.id, item.state]));
      expect(states.get("tool:bash")).toBe("unsupported");
      const shell = await runtime.backend.shell.start({
        argv: [process.execPath, "-e", "process.stdout.write('X')"],
        cwd: process.cwd(),
      });
      expect(shell.ok).toBe(false);
    } finally {
      await runtime.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("local-full 真实 shell 执行器：进程输出来自真实子进程", async () => {
    const root = tempRoot();
    const runtime = await boot("local-full", root);
    try {
      const marker = `T20_SHELL_${process.pid}`;
      const started = await runtime.backend.shell.start({
        argv: [process.execPath, "-e", `process.stdout.write(${JSON.stringify(marker)})`],
        cwd: process.cwd(),
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      const result = await started.value.exited;
      expect(result.stdout).toBe(marker);
      expect(result.termination).toBe("confirmed");
      expect(runtime.backend.evidence().some((item) => item.operation === "shell.start" && item.ok)).toBe(true);
    } finally {
      await runtime.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("multi-tenant 缺 origin 显式失败关闭，不回退为单租户", async () => {
    const root = tempRoot();
    await expect(
      createDefaultRuntime({ profile: "multi-tenant", agentRoot: root, projectRoot: root })
    ).rejects.toThrow(/TENANT_ORIGIN_REQUIRED/);
    rmSync(root, { recursive: true, force: true });
  });

  test("未知 profile 与冲突的后端档位都失败关闭，不生成两套装配", async () => {
    expect(() => createDefaultRuntime({ profile: "bogus" })).toThrow(/INVALID_PROFILE/);
    const root = tempRoot();
    await expect(
      createDefaultRuntime({
        profile: "local-full",
        backendProfile: "local-safe",
        agentRoot: root,
        projectRoot: root,
      })
    ).rejects.toThrow(/PROFILE_BACKEND_MISMATCH/);
    rmSync(root, { recursive: true, force: true });
  });
});
