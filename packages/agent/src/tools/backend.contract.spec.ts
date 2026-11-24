import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStructuredRecordingBackend,
  type StructuredExecutionBackend,
} from "@zeta-agent/security";
import { createAgent } from "../facade";

/** T-09 AC：每个文件工具都留下 backend 证据；degraded/抛错时宿主零变化。 */
describe("T-09 工具 backend 证据与失败关闭", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "zeta-be-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const toolText = (name: string, args: Record<string, unknown>): string =>
    `@@TOOL:${name}:${JSON.stringify(args)}@@`;

  async function runVia(
    backend: StructuredExecutionBackend,
    name: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const agent = createAgent({
      allowedDirectories: [root],
      securityBackend: backend,
      structuredBackend: backend,
      emissionPolicy: "direct",
      allowTextToolMarkers: true,
      streamFn: async function* () {
        yield toolText(name, args);
      },
    });
    const messages = await agent.prompt("go");
    const toolResult = [...messages].reverse().find((m) => m.role === "toolResult");
    return toolResult?.content;
  }

  test("read/ls/grep/find/write/edit 每次调用都留下结构化 backend 证据", async () => {
    writeFileSync(join(root, "a.txt"), "alpha\nbeta\n", "utf8");
    const backend = createStructuredRecordingBackend({ allowedDirectories: [root] });

    await runVia(backend, "read", { path: join(root, "a.txt") });
    await runVia(backend, "ls", { path: root });
    await runVia(backend, "grep", { path: join(root, "a.txt"), pattern: "alpha" });
    await runVia(backend, "find", { path: root, pattern: "a.txt" });
    await runVia(backend, "write", { path: join(root, "b.txt"), content: "written" });
    await runVia(backend, "edit", { path: join(root, "a.txt"), from: "alpha", to: "ALPHA" });

    const ops = backend.evidence().map((entry) => entry.operation);
    for (const op of ["file.read", "file.list", "file.write", "file.applyPatch"] as const) {
      expect(ops, `${op} evidence`).toContain(op);
    }
    expect(backend.evidence().length).toBeGreaterThanOrEqual(6);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toContain("ALPHA");
  });

  test("backend 非零退出时宿主零变化", async () => {
    const file = join(root, "locked.txt");
    writeFileSync(file, "original", "utf8");
    const backend = createStructuredRecordingBackend({ runExitCode: 1, allowedDirectories: [root] });

    const result = await runVia(backend, "write", { path: file, content: "tampered" });
    expect(JSON.stringify(result)).toMatch(/BACKEND_DENIED|COMMAND_FAILED|CRITICAL_LAYER/);
    expect(readFileSync(file, "utf8")).toBe("original");
  });

  test("backend 抛错时宿主零变化", async () => {
    const file = join(root, "thrown.txt");
    writeFileSync(file, "original", "utf8");
    const backend = createStructuredRecordingBackend({
      runThrow: new Error("BACKEND_EXPLODED"),
      allowedDirectories: [root],
    });

    const result = await runVia(backend, "write", { path: file, content: "tampered" });
    expect(JSON.stringify(result)).toContain("BACKEND_EXPLODED");
    expect(readFileSync(file, "utf8")).toBe("original");
  });
});
