import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResourceRegistry } from "./registry";
import type { ResourceEntry } from "./registry";

const EMBEDDED: readonly ResourceEntry[] = [
  {
    id: "agent:prompt:prompts/system.md",
    type: "prompt",
    scope: "agent",
    content: "---\nname: system:local\n---\n真实本地提示词",
    root: "embedded",
    relativePath: "prompts/system.md",
    embedded: true,
  },
  {
    id: "agent:skill:skills/builtins/SKILL.md",
    type: "skill",
    scope: "agent",
    content: "---\nname: builtins\n---\n真实技能",
    root: "embedded",
    relativePath: "skills/builtins/SKILL.md",
    embedded: true,
  },
  {
    id: "agent:schema:schema/config.zetaasset",
    type: "schema",
    scope: "agent",
    content: '{"title":"config:schema","type":"object"}',
    root: "embedded",
    relativePath: "schema/config.zetaasset",
    embedded: true,
  },
];

describe("T-20 单文件嵌入资源由 ResourceRegistry 消费", () => {
  test("嵌入 prompts/skills/schema 与磁盘资源进入同一清单，load 返回真实正文与 typed 解析", () => {
    const root = mkdtempSync(join(tmpdir(), "zeta-t20-embedded-"));
    try {
      const registry = createResourceRegistry({ agentRoot: root, projectRoot: root, embedded: EMBEDDED });
      const discovered = registry.discover();
      expect(discovered.entries.map((entry) => entry.id).sort()).toEqual(
        EMBEDDED.map((entry) => entry.id).sort()
      );
      for (const entry of EMBEDDED) {
        const loaded = registry.load(entry.id);
        expect(loaded.content).toBe(entry.content);
        expect(loaded.embedded).toBe(true);
        expect(loaded.parse?.ok).toBe(true);
      }
      expect(registry.load(EMBEDDED[0]!.id).parse?.ok === true).toBe(true);
      expect(registry.load(EMBEDDED[2]!.id).parse?.ok === true).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("嵌入资源不读宿主磁盘；磁盘缺失也不影响正文", () => {
    const registry = createResourceRegistry({ agentRoot: join(tmpdir(), "zeta-no-such-root"), embedded: EMBEDDED });
    registry.discover();
    expect(registry.load(EMBEDDED[1]!.id).content).toContain("真实技能");
  });
});
