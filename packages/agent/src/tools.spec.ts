import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Capabilities, ExecutionBackend, RunResult } from "@zeta-agent/security";
import { createAgent, type AgentEvent, type PluginTool } from "./facade";

function activeCapabilities(): Capabilities {
  return {
    isolation: "active",
    seccomp: "active",
    fsConfinement: "active",
    auditSink: "active",
    egressDefaultDeny: "active",
  };
}

function recordingBackend(calls: string[][], result: RunResult): ExecutionBackend {
  return {
    name: "recording-backend",
    capabilities: () => activeCapabilities(),
    run: async (command) => {
      calls.push([...command.argv]);
      return result;
    },
    dispose: () => {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("T-11 内置工具真实化", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "zeta-tools-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const toolNames = ["read", "bash", "edit", "write", "grep", "find", "ls", "powershell"] as const;
  const toolText = (name: string, args: Record<string, unknown>): string =>
    `@@TOOL:${name}:${JSON.stringify(args)}@@`;

  async function runTool(
    name: string,
    args: Record<string, unknown>,
    options: Parameters<typeof createAgent>[0] = {}
  ): Promise<unknown> {
    const agent = createAgent({
      allowedDirectories: [root],
      streamFn: async function* () {
        yield toolText(name, args);
      },
      // 测试通过文本标记驱动内置工具；显式 opt-in。
      allowTextToolMarkers: true,
      ...options,
    });
    const result = await agent.prompt("go");
    const toolResult = [...result].reverse().find((message) => message.role === "toolResult");
    return toolResult?.content;
  }

  test("内置工具集扩为 read/bash/edit/write/grep/find/ls/powershell 且各自有 ToolDefinition", () => {
    const agent = createAgent();
    for (const name of toolNames) expect(agent.toolNames).toContain(name);

    const definitions = agent.toolDefinitions as readonly unknown[] as Array<Record<string, unknown>>;
    for (const name of toolNames) {
      const definition = definitions.find((item) => item.name === name);
      expect(definition, `${name} ToolDefinition`).toBeDefined();
      expect(typeof definition?.label).toBe("string");
      expect(typeof definition?.description).toBe("string");
      expect(typeof definition?.execute).toBe("function");
      expect(typeof definition?.renderCall).toBe("function");
      expect(typeof definition?.renderResult).toBe("function");
      expect(Array.isArray(definition?.parameters)).toBe(true);
    }
  });

  test("read 读取受控目录内的文件，产出结构化结果", async () => {
    const file = join(root, "a.txt");
    writeFileSync(file, "hello world");
    const content = await runTool("read", { path: file });
    expect(isRecord(content)).toBe(true);
    if (isRecord(content)) {
      expect(content.ok).toBe(true);
      expect(content.path).toBe(file);
      expect(content.content).toBe("hello world");
    }
  });

  test("write 在受控目录内写文件并返回结构化结果", async () => {
    const file = join(root, "out.txt");
    const content = await runTool("write", { path: file, content: "written" });
    expect(isRecord(content)).toBe(true);
    if (isRecord(content)) {
      expect(content.ok).toBe(true);
      expect(content.path).toBe(file);
      expect(content.bytes).toBe(7);
    }
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(file, "utf8")).toBe("written");
  });

  test("edit 对受控目录文件做精确替换", async () => {
    const file = join(root, "edit.txt");
    writeFileSync(file, "foo bar foo");
    const content = await runTool("edit", { path: file, from: "foo", to: "baz" });
    expect(isRecord(content)).toBe(true);
    if (isRecord(content)) {
      expect(content.ok).toBe(true);
      expect(content.replacements).toBe(2);
    }
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(file, "utf8")).toBe("baz bar baz");
  });

  test("ls 列出受控目录内容，grep 搜索匹配行，find 按名称查找", async () => {
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "a.txt"), "alpha\nbeta\nalpha end\n");
    writeFileSync(join(root, "sub", "b.md"), "nested alpha");

    const listed = await runTool("ls", { path: root });
    expect(isRecord(listed)).toBe(true);
    if (isRecord(listed)) {
      const entries = listed.entries as Array<{ name: string }>;
      expect(entries.map((entry) => entry.name).sort()).toEqual(["a.txt", "sub"]);
    }

    const grepped = await runTool("grep", { path: join(root, "a.txt"), pattern: "alpha" });
    expect(isRecord(grepped)).toBe(true);
    if (isRecord(grepped)) {
      const matches = grepped.matches as Array<{ line: number }>;
      expect(matches.map((match) => match.line)).toEqual([1, 3]);
    }

    const found = await runTool("find", { path: root, pattern: "b.md" });
    expect(isRecord(found)).toBe(true);
    if (isRecord(found)) {
      const paths = found.paths as string[];
      expect(paths).toContain(join(root, "sub", "b.md"));
    }
  });

  test("bash/powershell 经 ExecutionBackend 执行并回传结构化结果", async () => {
    const calls: string[][] = [];
    const backend = recordingBackend(calls, {
      exitCode: 0,
      stdout: "command output",
      stderr: "",
      isolated: null,
    });

    const bashResult = await runTool("bash", { command: "echo hi" }, { securityBackend: backend });
    expect(isRecord(bashResult)).toBe(true);
    if (isRecord(bashResult)) {
      expect(bashResult.ok).toBe(true);
      expect(bashResult.stdout).toBe("command output");
      expect(bashResult.exitCode).toBe(0);
    }
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]).toContain("echo hi");

    const psResult = await runTool("powershell", { command: "Write-Output hi" }, { securityBackend: backend });
    expect(isRecord(psResult)).toBe(true);
    if (isRecord(psResult)) expect(psResult.ok).toBe(true);
    expect(calls.some((argv) => argv.includes("Write-Output hi"))).toBe(true);
  });

  test("关键层降级时 bash 工具 refuses to execute", async () => {
    const degraded: Capabilities = { ...activeCapabilities(), seccomp: "degraded" };
    const backend: ExecutionBackend = {
      name: "degraded",
      capabilities: () => degraded,
      run: async () => ({ exitCode: 0, stdout: "should not run", stderr: "", isolated: null }),
      dispose: () => {},
    };
    const content = await runTool("bash", { command: "echo hi" }, { securityBackend: backend });
    const text = isRecord(content) ? String(content.error ?? "") : String(content);
    expect(text).toContain("CRITICAL_LAYER_DEGRADED");
  });

  test("文件工具拒绝受控目录之外的路径", async () => {
    const outside = resolve(root, "..", `zeta-outside-${Date.now()}`);
    const content = await runTool("read", { path: outside });
    const text = isRecord(content) ? String(content.error ?? "") : String(content);
    expect(text).toMatch(/CONFINEMENT|outside/i);
  });

  test("工具调用标记通道仍走 toolRegistry，渲染函数生成可读文本", async () => {
    const events: AgentEvent[] = [];
    const agent = createAgent({
      streamFn: async function* () {
        yield toolText("ls", { path: root });
      },
      allowTextToolMarkers: true,
    });
    agent.subscribe((event) => {
      events.push(event);
    });
    await agent.prompt("go");

    expect(events.some((event) => event.type === "tool_execution_start")).toBe(true);
    expect(events.some((event) => event.type === "tool_execution_end")).toBe(true);

    const definitions = agent.toolDefinitions as readonly unknown[] as Array<Record<string, unknown>>;
    const ls = definitions.find((item) => item.name === "ls");
    if (ls?.renderCall && ls?.renderResult) {
      const callText = (ls.renderCall as (args: unknown) => string)({ path: root });
      expect(callText).toContain("ls");
      const resultText = (ls.renderResult as (value: unknown) => string)({ ok: true, entries: [] });
      expect(typeof resultText).toBe("string");
      expect(resultText.length).toBeGreaterThan(0);
    }
  });

  test("已有 runLoop 事件序列契约不被内置工具改动破坏", async () => {
    const agent = createAgent({
      streamFn: async function* () {
        yield "hello";
      },
    });
    const events: AgentEvent[] = [];
    agent.subscribe((event) => {
      events.push(event);
    });
    await agent.prompt("hi");
    expect(events.map((event) => event.type)).toEqual([
      "agent_start",
      "turn_start",
      "message_start",
      "message_end",
      "message_start",
      "message_update",
      "message_end",
      "turn_end",
      "agent_end",
    ]);
  });

  test("插件 registerTool 可覆盖同名内置工具（replaceable）", async () => {
    const override: PluginTool<never> = {
      name: "read",
      execute: () => ({ ok: true, overridden: true }),
    };
    const agent = createAgent({
      plugins: [],
      streamFn: async function* () {
        yield toolText("read", { path: join(root, "a.txt") });
      },
      allowTextToolMarkers: true,
    });
    agent.api.registerTool(override);
    const result = await agent.prompt("go");
    const toolResult = [...result].reverse().find((message) => message.role === "toolResult");
    expect(isRecord(toolResult?.content)).toBe(true);
    if (isRecord(toolResult?.content)) expect(toolResult.content.overridden).toBe(true);
  });
});
