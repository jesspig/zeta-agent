import { describe, expect, test } from "bun:test";
import { createContext } from "@zeta-agent/framework";
import {
  agentsRegistryKey,
  promptsRegistryKey,
  resourceKeyFor,
  skillsRegistryKey,
  themesRegistryKey,
} from "./keys";
import { installResourcePlugin } from "./plugin";
import { createResourceRegistry } from "./registry";
import { createTrustGate } from "./trust";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("T-12 资源 coeffect 键与 provider", () => {
  test("四类 registry key 名称与设计契约一致", () => {
    const qualified = (key: { namespace: string; name: string }): string => `${key.namespace}:${key.name}`;
    expect(qualified(skillsRegistryKey)).toBe("@zeta-agent/skills:registry");
    expect(qualified(promptsRegistryKey)).toBe("@zeta-agent/prompts:registry");
    expect(qualified(themesRegistryKey)).toBe("@zeta-agent/themes:registry");
    expect(qualified(agentsRegistryKey)).toBe("@zeta-agent/agents:registry");
    expect(resourceKeyFor("skill")).toBe(skillsRegistryKey);
  });

  test("installResourcePlugin 提供四类资源并在 refresh 后重激活", async () => {
    const root = mkdtempSync(join(tmpdir(), "zeta-coeffect-"));
    mkdirSync(join(root, "skills", "demo"), { recursive: true });
    writeFileSync(join(root, "skills", "demo", "SKILL.md"), "---\nname: demo\n---\nbody");
    const ctx = createContext();
    const registry = createResourceRegistry({ agentRoot: root, trust: createTrustGate() });
    const handle = installResourcePlugin({ ctx, registry, roots: [root] });
    try {
      expect(ctx.get(skillsRegistryKey).length).toBe(1);
      expect(ctx.get(promptsRegistryKey).length).toBe(0);
      expect(ctx.get(agentsRegistryKey).length).toBe(0);

      mkdirSync(join(root, "skills", "second"), { recursive: true });
      writeFileSync(join(root, "skills", "second", "SKILL.md"), "---\nname: second\n---\nbody");
      await handle.refresh();
      expect(ctx.get(skillsRegistryKey).length).toBe(2);
    } finally {
      handle.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("T-12 资源 watch 撤销", () => {
  test("check 检测目录变化并触发 onChange，close 后停止 watcher", async () => {
    const root = mkdtempSync(join(tmpdir(), "zeta-watch-"));
    mkdirSync(join(root, "prompts"), { recursive: true });
    const closed: string[] = [];
    let changes = 0;
    const { createResourceWatcher } = await import("./watch");
    const watcher = createResourceWatcher({
      roots: [root],
      onChange: () => { changes += 1; },
      watcherFactory: (watched, cb) => {
        void watched;
        void cb;
        return { close: () => closed.push(watched) };
      },
    });
    try {
      expect(await watcher.check()).toBe(false);
      writeFileSync(join(root, "prompts", "p.md"), "prompt");
      expect(await watcher.check()).toBe(true);
      expect(changes).toBe(1);
      expect(await watcher.check()).toBe(false);
    } finally {
      watcher.close();
    }
    expect(closed).toEqual([root]);
    rmSync(root, { recursive: true, force: true });
  });
});
