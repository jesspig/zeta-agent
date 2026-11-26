import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capabilities, OperationCapabilityReport } from "@zeta-agent/security";
import { listAssembly } from "../facade";
import { createResourceRegistry } from "../resources/registry";
import { createDefaultRuntime } from "./runtime";
import {
  ASSEMBLY_PROFILES,
  BUILTIN_PLUGINS,
  builtinsForProfile,
  resolveAssemblyProfile,
} from "./builtins";
import { createAssemblyManifest } from "./manifest";
import { diagnoseCapabilities, executableToolNames, operationForTool } from "./profile";

const LOCAL_SAFE_CAPABILITIES: Capabilities = {
  isolation: "unsupported",
  seccomp: "unsupported",
  fsConfinement: "active",
  auditSink: "unsupported",
  egressDefaultDeny: "unsupported",
};

const LOCAL_SAFE_OPERATIONS: OperationCapabilityReport = {
  operations: {
    "file.read": "active",
    "file.list": "active",
    "file.write": "active",
    "file.applyPatch": "active",
    "shell.start": "unsupported",
    "session.open": "unsupported",
    cleanup: "active",
  },
};

const LOCAL_FULL_OPERATIONS: OperationCapabilityReport = {
  operations: {
    ...LOCAL_SAFE_OPERATIONS.operations,
    "shell.start": "active",
    "session.open": "active",
  },
};

const tempRoot = mkdtempSync(join(tmpdir(), "zeta-assembly-"));
mkdirSync(join(tempRoot, "skills", "demo"), { recursive: true });
writeFileSync(join(tempRoot, "skills", "demo", "SKILL.md"), "---\nname: demo\n---\nbody", "utf8");
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

describe("T-10 真实 BUILTIN_PLUGINS 与安装注册表清单", () => {
  test("BUILTIN_PLUGINS 只登记代码中真实存在的 builtin，不含虚构 skill/session 或研究 seam", () => {
    expect(ASSEMBLY_PROFILES).toEqual([
      "local-safe",
      "local-full",
      "daemon",
      "remote",
      "research",
      "multi-tenant",
    ]);
    expect(BUILTIN_PLUGINS.length).toBeGreaterThan(0);

    const ids = BUILTIN_PLUGINS.map((plugin) => plugin.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const plugin of BUILTIN_PLUGINS) {
      expect(plugin.name.length).toBeGreaterThan(0);
      expect(["tool", "service", "session", "mode"]).toContain(plugin.kind);
      expect(plugin.profiles.length).toBeGreaterThan(0);
      expect(plugin.id).not.toMatch(/research|evolution|fitness|experience|rsi|dream/i);
    }

    const toolNames = BUILTIN_PLUGINS.filter((plugin) => plugin.kind === "tool").map((plugin) => plugin.name);
    for (const name of ["read", "ls", "grep", "find", "write", "edit", "bash", "powershell"]) {
      expect(toolNames, `builtin tool ${name}`).toContain(name);
    }
    expect(BUILTIN_PLUGINS.some((plugin) => plugin.kind === "session" && plugin.name === "session:store")).toBe(true);
    expect(BUILTIN_PLUGINS.some((plugin) => plugin.kind === "mode" && plugin.name === "rpc")).toBe(true);
  });

  test("local-safe 是默认 profile；local-full 显式 opt-in 且装载更多真实 service", () => {
    expect(resolveAssemblyProfile(undefined)).toBe("local-safe");
    expect(resolveAssemblyProfile("local-full")).toBe("local-full");
    expect(() => resolveAssemblyProfile("bogus")).toThrow(/PROFILE/);

    const safe = builtinsForProfile("local-safe");
    const full = builtinsForProfile("local-full");
    expect(safe.length).toBeLessThan(full.length);
    for (const plugin of safe) expect(full.some((item) => item.id === plugin.id)).toBe(true);
  });

  test("manifest 从安装注册表生成，只列出真实发现的 skill，不手写不存在的资源", () => {
    const registry = createResourceRegistry({ agentRoot: tempRoot });
    const discovered = registry.discover().entries;
    expect(discovered.length).toBe(1);

    const manifest = createAssemblyManifest({
      profile: "local-safe",
      resources: discovered.map((entry) => ({
        id: entry.id,
        type: entry.type,
        scope: entry.scope,
        relativePath: entry.relativePath,
      })),
    });

    expect(manifest.resources.map((entry) => entry.id)).toEqual(["agent:skill:demo/SKILL.md"]);
    expect(manifest.resources.some((entry) => /no-such-skill|missing/i.test(entry.id))).toBe(false);
    expect(manifest.profile).toBe("local-safe");
    expect(manifest.plugins).toEqual(listAssembly());
    expect(manifest.tools.length).toBe(8);
    expect(manifest.modes).toEqual(["interactive", "print", "json", "rpc"]);
  });

  test("默认装配快照：manifest 与 facade 清单一致，且 CLI/SDK 走同一生成函数", () => {
    const sdk = createAssemblyManifest({ profile: "local-safe" });
    const cli = createAssemblyManifest({ profile: "local-safe" });

    expect(cli).toEqual(sdk);
    expect(sdk.plugins).toEqual(listAssembly());
    expect(sdk.services).toContain("skills:registry");
    expect(sdk.session).toEqual(["session:store"]);
    for (const id of sdk.plugins) {
      expect(id).toMatch(/^(builtin|skills|session|mode|service):/);
      expect(id).not.toMatch(/research|evolution|fitness|experience|rsi/i);
    }
  });
});

describe("T-10 profile 能力诊断与 active registry schema", () => {
  test("local-safe 诊断如实报告 shell unsupported，文件操作 active", () => {
    const diagnostics = diagnoseCapabilities("local-safe", LOCAL_SAFE_CAPABILITIES, LOCAL_SAFE_OPERATIONS);
    const byId = new Map(diagnostics.map((item) => [item.id, item]));

    expect(byId.get("operation:file.read")?.state).toBe("active");
    expect(byId.get("operation:shell.start")?.state).toBe("unsupported");
    expect(byId.get("tool:read")?.state).toBe("active");
    expect(byId.get("tool:bash")?.state).toBe("unsupported");
    expect(byId.get("capability:isolation")?.state).toBe("unsupported");
    expect(byId.get("capability:fsConfinement")?.state).toBe("active");
    expect(diagnostics.every((item) => item.reason.length > 0)).toBe(true);
  });

  test("能力诊断映射与真实执行路径一致：grep 走 file.read，find 走 file.list", () => {
    expect(operationForTool("grep")).toBe("file.read");
    expect(operationForTool("find")).toBe("file.list");
    expect(operationForTool("read")).toBe("file.read");
    expect(operationForTool("ls")).toBe("file.list");

    // grep 的可见性必须跟随 file.read，而不是 file.list。
    const readDisabled: OperationCapabilityReport = {
      operations: { ...LOCAL_SAFE_OPERATIONS.operations, "file.read": "unsupported" },
    };
    const diagnostics = diagnoseCapabilities("local-safe", LOCAL_SAFE_CAPABILITIES, readDisabled);
    const byId = new Map(diagnostics.map((item) => [item.id, item]));
    expect(byId.get("operation:file.read")?.state).toBe("unsupported");
    expect(byId.get("operation:file.list")?.state).toBe("active");
    expect(byId.get("tool:grep")?.state).toBe("unsupported");
    expect(byId.get("tool:find")?.state).toBe("active");
  });

  test("local-full 的真实 shell 声明 active，但未实现的系统隔离仍如实 unsupported", () => {
    const diagnostics = diagnoseCapabilities("local-full", LOCAL_SAFE_CAPABILITIES, LOCAL_FULL_OPERATIONS);
    expect(diagnostics.find((item) => item.id === "tool:bash")?.state).toBe("active");
    expect(diagnostics.find((item) => item.id === "operation:shell.start")?.state).toBe("active");
    expect(diagnostics.find((item) => item.id === "capability:isolation")?.state).toBe("unsupported");
    expect(diagnostics.find((item) => item.id === "capability:seccomp")?.state).toBe("unsupported");
  });

  test("provider schema 只暴露可执行工具；不支持的工具被明确禁用且进入诊断", () => {
    const diagnostics = diagnoseCapabilities("local-safe", LOCAL_SAFE_CAPABILITIES, LOCAL_SAFE_OPERATIONS);
    const active = executableToolNames(
      ["read", "ls", "grep", "find", "write", "edit", "bash", "powershell", "mcp__custom"],
      diagnostics
    );

    for (const name of ["read", "ls", "grep", "find", "write", "edit", "mcp__custom"]) {
      expect(active, name).toContain(name);
    }
    for (const name of ["bash", "powershell"]) {
      expect(active, name).not.toContain(name);
      expect(diagnostics.find((item) => item.id === `tool:${name}`)?.state).toBe("unsupported");
    }
  });

  test("provider schema 由最终 active registry 生成，模型看不到不支持的工具", async () => {
    const seenTools: Array<readonly { readonly name: string }[]> = [];
    const runtime = await createDefaultRuntime({
      profile: "local-safe",
      streamFn: async function* (request) {
        seenTools.push(request.tools ?? []);
        yield "ok";
      },
    });

    await runtime.agent.prompt("hi");
    const names = (seenTools[0] ?? []).map((tool) => tool.name);
    expect(names).toContain("read");
    expect(names).toContain("write");
    expect(names).not.toContain("bash");
    expect(names).not.toContain("powershell");
    expect(runtime.agent.activeToolNames).toContain("read");
    expect(runtime.agent.activeToolNames).not.toContain("bash");
    expect(runtime.agent.capabilityDiagnostics.find((item) => item.id === "tool:bash")?.state).toBe("unsupported");
    await runtime.dispose();
  });

  test("默认装配 dispose 单链幂等，dispose 后 agent 拒绝新 run/runTool", async () => {
    const runtime = await createDefaultRuntime({
      includeBuiltins: false,
      streamFn: async function* () { yield "ok"; },
    });
    const first = runtime.dispose();
    expect(runtime.dispose()).toBe(first);
    await first;
    expect(runtime.agent.disposed).toBe(true);
    expect(runtime.agent.activeLeaseCount).toBe(0);
    await expect(runtime.agent.prompt("after-dispose")).rejects.toThrow(/AGENT_DISPOSED/);
    await expect(runtime.agent.runTool({ name: "noop", execute: () => "ok" })).rejects.toThrow(/AGENT_DISPOSED/);
  });
});
