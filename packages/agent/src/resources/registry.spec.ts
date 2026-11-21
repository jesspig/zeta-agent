import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTrustGate } from "./trust";
import { createResourceRegistry } from "./registry";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "zeta-resource-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function seedResources(root: string): void {
  mkdirSync(join(root, "skills", "demo"), { recursive: true });
  writeFileSync(join(root, "skills", "demo", "SKILL.md"), "# Demo Skill");
  mkdirSync(join(root, "prompts"), { recursive: true });
  writeFileSync(join(root, "prompts", "hello.md"), "Hello prompt");
  mkdirSync(join(root, "themes"), { recursive: true });
  writeFileSync(join(root, "themes", "solar.json"), '{"name":"solar"}');
}

describe("T-15 资源发现（skills / prompts / themes）", () => {
  test("discover 发现 agent 目录三类资源并带正确 scope", () => {
    const agentRoot = tempDir();
    seedResources(agentRoot);

    const registry = createResourceRegistry({ agentRoot });
    const manifest = registry.discover();

    expect(manifest.entries.map((e) => e.type).sort()).toEqual(["prompt", "skill", "theme"]);
    expect(manifest.entries.every((e) => e.scope === "agent")).toBe(true);
    expect(manifest.entries.find((e) => e.type === "skill")?.content).toContain("Demo Skill");
  });

  test("discover 合并项目级目录资源", () => {
    const agentRoot = tempDir();
    const projectRoot = tempDir();
    seedResources(agentRoot);
    mkdirSync(join(projectRoot, "skills", "proj"), { recursive: true });
    writeFileSync(join(projectRoot, "skills", "proj", "SKILL.md"), "# Project Skill");

    const registry = createResourceRegistry({ agentRoot, projectRoot });
    const manifest = registry.discover();

    expect(manifest.entries.some((e) => e.scope === "agent")).toBe(true);
    expect(manifest.entries.some((e) => e.scope === "project")).toBe(true);
  });
});

describe("T-15 trust 门控", () => {
  test("agent 目录资源无需授权即可读取", () => {
    const agentRoot = tempDir();
    seedResources(agentRoot);
    const registry = createResourceRegistry({
      agentRoot,
      trust: createTrustGate(),
    });
    registry.discover();
    const skill = registry.discover().entries.find((e) => e.type === "skill");
    expect(skill).toBeDefined();
    expect(() => registry.load(skill!.id)).not.toThrow();
  });

  test("项目本地资源未授权时拒绝加载（TRUST_REQUIRED）", () => {
    const agentRoot = tempDir();
    const projectRoot = tempDir();
    seedResources(agentRoot);
    mkdirSync(join(projectRoot, "prompts"), { recursive: true });
    writeFileSync(join(projectRoot, "prompts", "secret.md"), "project prompt");

    const registry = createResourceRegistry({
      agentRoot,
      projectRoot,
      trust: createTrustGate(),
    });
    registry.discover();
    const projectPrompt = registry.discover().entries.find(
      (e) => e.scope === "project" && e.type === "prompt",
    );
    expect(projectPrompt).toBeDefined();
    let error: unknown;
    try {
      registry.load(projectPrompt!.id);
    } catch (caught) {
      error = caught;
    }
    expect((error as { code?: string } | undefined)?.code).toBe("TRUST_REQUIRED");
  });

  test("授权项目后项目资源可加载；撤销后再次拒绝", () => {
    const agentRoot = tempDir();
    const projectRoot = tempDir();
    seedResources(agentRoot);
    mkdirSync(join(projectRoot, "themes"), { recursive: true });
    writeFileSync(join(projectRoot, "themes", "proj.json"), "{}");

    const trust = createTrustGate();
    const registry = createResourceRegistry({ agentRoot, projectRoot, trust });
    registry.discover();
    const theme = registry.discover().entries.find(
      (e) => e.scope === "project" && e.type === "theme",
    );
    expect(theme).toBeDefined();

    trust.authorize(projectRoot);
    expect(() => registry.load(theme!.id)).not.toThrow();

    trust.revoke(projectRoot);
    expect(() => registry.load(theme!.id)).toThrow();
  });
});

describe("T-15 资源清单刷新", () => {
  test("refresh 重新扫描并返回新 generation，反映新增资源", () => {
    const agentRoot = tempDir();
    seedResources(agentRoot);
    const registry = createResourceRegistry({ agentRoot });

    const first = registry.discover();
    expect(first.entries).toHaveLength(3);

    writeFileSync(join(agentRoot, "prompts", "second.md"), "Second");
    const second = registry.refresh();

    expect(second.generation).toBe(first.generation + 1);
    expect(second.entries).toHaveLength(4);
  });
});
