import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ResourceParseError,
  builtinParsers,
  defineParserPlugin,
  parseResource,
  type ParsedResource,
} from "./parser";
import { createResourceRegistry, type ResourceEntry } from "./registry";

function entry(overrides: Partial<ResourceEntry> = {}): ResourceEntry {
  return {
    id: "agent:skill:demo/SKILL.md",
    type: "skill",
    scope: "agent",
    content: "",
    root: "/tmp/agent",
    relativePath: "demo/SKILL.md",
    ...overrides,
  };
}

describe("T-12 资源解析器插件与 typed fail", () => {
  test("SKILL.md frontmatter 解析为 name/description/body", () => {
    const source = "---\nname: demo\ndescription: a demo skill\n---\n# Body\n";
    const result = parseResource(entry(), source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe("demo");
    expect(result.value.description).toBe("a demo skill");
    expect(result.value.body).toContain("# Body");
  });

  test("未闭合 frontmatter 返回 typed FORMAT_MISMATCH，而非抛出裸异常", () => {
    const result = parseResource(entry(), "---\nname: broken\nno closer");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ResourceParseError);
    expect(result.error.code).toBe("FORMAT_MISMATCH");
  });

  test("theme-json 非法 JSON 返回 typed INVALID_CONTENT", () => {
    const result = parseResource(entry({ type: "theme", id: "agent:theme:bad.json", relativePath: "bad.json" }), "{nope");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_CONTENT");
  });

  test("agents.md 与 prompt.md 有内建解析器", () => {
    const agents = parseResource(entry({ type: "agents", id: "agent:agents:AGENTS.md", relativePath: "AGENTS.md" }), "---\nname: repo\n---\nRules");
    const prompt = parseResource(entry({ type: "prompt", id: "agent:prompt:hi.md", relativePath: "hi.md" }), "Hello");
    expect(agents.ok).toBe(true);
    expect(prompt.ok).toBe(true);
    expect(builtinParsers.map((p) => p.kind).sort()).toEqual(["agents", "prompt", "skill", "theme"]);
  });

  test("自定义解析器可替换内建解析器", () => {
    const custom = defineParserPlugin({
      kind: "skill",
      accepts: ["custom"],
      parse: (source): ParsedResource => ({ name: "custom", description: "", body: source, frontmatter: {} }),
    });
    const result = parseResource(entry(), "anything", [custom]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe("custom");
  });

  test("registry.load 附带 typed 解析结果，发现阶段不解析正文", () => {
    const root = mkdtempSync(join(tmpdir(), "zeta-parser-"));
    mkdirSync(join(root, "skills", "demo"), { recursive: true });
    writeFileSync(join(root, "skills", "demo", "SKILL.md"), "---\nname: demo\n---\nbody");
    mkdirSync(join(root, "skills", "broken"), { recursive: true });
    writeFileSync(join(root, "skills", "broken", "SKILL.md"), "---\nname: nope");
    try {
      const registry = createResourceRegistry({ agentRoot: root });
      const manifest = registry.discover();
      const good = manifest.entries.find((e) => e.relativePath === "demo/SKILL.md")!;
      const bad = manifest.entries.find((e) => e.relativePath === "broken/SKILL.md")!;
      expect(good.parse).toBeUndefined();
      expect(registry.load(good.id).parse?.ok).toBe(true);
      const failed = registry.load(bad.id).parse;
      expect(failed?.ok).toBe(false);
      if (failed && !failed.ok) expect(failed.error.code).toBe("FORMAT_MISMATCH");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("registry 发现 agents/AGENTS.md 并附 typed 解析结果", () => {
    const root = mkdtempSync(join(tmpdir(), "zeta-agents-"));
    mkdirSync(join(root, "agents"), { recursive: true });
    writeFileSync(join(root, "agents", "AGENTS.md"), "---\nname: repo\n---\nRules");
    try {
      const registry = createResourceRegistry({ agentRoot: root });
      const agents = registry.discover().entries.filter((e) => e.type === "agents");
      expect(agents).toHaveLength(1);
      expect(agents[0]?.scope).toBe("agent");
      const loaded = registry.load(agents[0]!.id);
      expect(loaded.parse?.ok).toBe(true);
      if (loaded.parse?.ok) expect(loaded.parse.value.name).toBe("repo");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
