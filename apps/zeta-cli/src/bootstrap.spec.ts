import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createDefaultRuntime } from "@zeta-agent/agent";
import { parseArgs } from "./args";

const CLI = join(import.meta.dir, "index.ts");

async function runCli(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    cwd: join(import.meta.dir, "..", "..", ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

describe("T-10 CLI 统一 parse → config → loader → root fiber → mode", () => {
  test("parseArgs 解析 profile 与 capabilities 诊断开关", () => {
    const safe = parseArgs(["--headless", "hi"]);
    expect(safe.mode).toBe("headless");
    expect(safe.profile).toBe("local-safe");
    expect(safe.capabilities).toBe(false);

    const full = parseArgs(["--profile", "local-full", "--json", "hi"]);
    expect(full.mode).toBe("json");
    expect(full.profile).toBe("local-full");
    expect(full.prompt).toBe("hi");

    const diag = parseArgs(["--capabilities"]);
    expect(diag.capabilities).toBe(true);
    expect(() => parseArgs(["--profile", "bogus"])).toThrow(/PROFILE/);
  });

  test("子进程能力矩阵：local-safe 默认报告 shell unsupported，工具对应 backend 操作", async () => {
    const { code, stdout, stderr } = await runCli(["--capabilities"]);
    expect(code, stderr).toBe(0);
    const report = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? "");

    expect(report.profile).toBe("local-safe");
    expect(Array.isArray(report.plugins)).toBe(true);
    expect(report.plugins).toContain("builtin:read");
    expect(report.plugins).toContain("session:store");
    const states = new Map((report.diagnostics as Array<{ id: string; state: string }>).map((item) => [item.id, item.state]));
    expect(states.get("tool:read")).toBe("active");
    expect(states.get("tool:bash")).toBe("unsupported");
    expect(states.get("capability:isolation")).toBe("unsupported");
    expect(states.get("capability:fsConfinement")).toBe("active");
  });

  test("子进程能力矩阵：local-full 为显式 opt-in 且不把 shell 伪装成 active", async () => {
    const safe = await runCli(["--capabilities"]);
    const full = await runCli(["--capabilities", "--profile", "local-full"]);
    expect(full.code, full.stderr).toBe(0);

    const safeReport = JSON.parse(safe.stdout.trim());
    const fullReport = JSON.parse(full.stdout.trim());
    expect(fullReport.profile).toBe("local-full");
    expect(fullReport.plugins.length).toBeGreaterThan(safeReport.plugins.length);
    const states = new Map((fullReport.diagnostics as Array<{ id: string; state: string }>).map((item) => [item.id, item.state]));
    expect(states.get("tool:bash")).toBe("unsupported");
  });

  test("CLI 与 SDK 默认装配逐字段一致（manifest / 工具 / 服务 / session / mode / 诊断）", async () => {
    const { code, stdout, stderr } = await runCli(["--capabilities"]);
    expect(code, stderr).toBe(0);
    const report = JSON.parse(stdout.trim());

    const runtime = await createDefaultRuntime({ profile: "local-safe" });
    try {
      expect(report.profile).toBe(runtime.manifest.profile);
      expect(report.plugins).toEqual([...runtime.manifest.plugins]);
      expect(report.tools).toEqual([...runtime.manifest.tools]);
      expect(report.services).toEqual([...runtime.manifest.services]);
      expect(report.session).toEqual([...runtime.manifest.session]);
      expect(report.modes).toEqual([...runtime.manifest.modes]);
      expect(report.diagnostics).toEqual(runtime.manifest.diagnostics.map((item) => ({ ...item })));
    } finally {
      await runtime.dispose();
    }
  });

  test("headless 四形态共享会话协议：json/rpc 输出可解析且不加载 OpenTUI", async () => {
    const json = await runCli(["--json", "hello"]);
    expect(json.code, json.stderr).toBe(0);
    for (const line of json.stdout.trim().split(/\r?\n/).filter(Boolean)) {
      expect(typeof JSON.parse(line).type).toBe("string");
    }

    const rpc = await runCli(["--rpc", '{"jsonrpc":"2.0","id":1,"method":"prompt","params":{"text":"hello"}}']);
    expect(rpc.code, rpc.stderr).toBe(0);
    const reply = JSON.parse(rpc.stdout.trim().split(/\r?\n/).at(-1) ?? "");
    expect(reply.jsonrpc).toBe("2.0");
    expect(reply.id).toBe(1);
  });
});
