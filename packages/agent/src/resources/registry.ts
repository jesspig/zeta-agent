import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { builtinParsers, parseResource, type ParseResult, type ParserPlugin } from "./parser";
import type { TrustGate } from "./trust";

// MCP server 配置 coeffect 由 plugins/mcp 实现（@zeta-agent/mcp:servers）。
export type ResourceType = "skill" | "prompt" | "theme" | "agents";
export type ResourceScope = "agent" | "project";

/** 四类资源在目录中的约定：目录名、扩展名、是否递归。 */
const RESOURCE_LAYOUT: Readonly<Record<ResourceType, { dir: string; ext: string; recursive: boolean }>> = {
  skill: { dir: "skills", ext: "SKILL.md", recursive: true },
  prompt: { dir: "prompts", ext: ".md", recursive: false },
  theme: { dir: "themes", ext: ".json", recursive: false },
  agents: { dir: "agents", ext: "AGENTS.md", recursive: true },
};

export const RESOURCE_TYPES: readonly ResourceType[] = Object.freeze(["skill", "prompt", "theme", "agents"]);

export interface ResourceEntry {
  readonly id: string;
  readonly type: ResourceType;
  readonly scope: ResourceScope;
  readonly content: string;
  /** 资源所在根目录（用于 trust 门控）。 */
  readonly root: string;
  /** 相对于类型目录的路径。 */
  readonly relativePath: string;
  /** load 时的 typed 解析结果；发现阶段为 undefined。 */
  readonly parse?: ParseResult;
}

export interface ResourceManifest {
  readonly entries: readonly ResourceEntry[];
  readonly generation: number;
}

export interface ResourceRegistry {
  /** 返回当前清单（首次自动扫描）。 */
  discover(): ResourceManifest;
  /** 重新扫描资源目录并返回新清单（generation +1）。 */
  refresh(): ResourceManifest;
  /** 加载资源；项目级资源未授权时抛 TRUST_REQUIRED。 */
  load(id: string): ResourceEntry;
}

export interface ResourceRegistryOptions {
  readonly agentRoot: string;
  readonly projectRoot?: string;
  readonly trust?: TrustGate;
  /** 可替换的解析器插件；缺省为内建 skill/prompt/theme/agents 解析器。 */
  readonly parsers?: readonly ParserPlugin[];
}

function walk(dir: string, recursive: boolean): string[] {
  const out: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) out.push(...walk(full, true));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function matches(name: string, ext: string): boolean {
  return ext.startsWith(".") ? name.endsWith(ext) : name === ext;
}

function scanRoot(root: string, scope: ResourceScope): ResourceEntry[] {
  const found: ResourceEntry[] = [];
  for (const type of RESOURCE_TYPES) {
    const layout = RESOURCE_LAYOUT[type];
    const base = join(root, layout.dir);
    let stat: import("node:fs").Stats;
    try {
      stat = statSync(base);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const file of walk(base, layout.recursive)) {
      if (!matches(file.split(/[\\/]/).at(-1) ?? "", layout.ext)) continue;
      const relativePath = relative(base, file).split(sep).join("/");
      // 发现阶段只登记元数据；正文只在 load 且通过信任门后读取，避免越权泄露。
      found.push({
        id: `${scope}:${type}:${relativePath}`,
        type,
        scope,
        content: "",
        root,
        relativePath,
      });
    }
  }
  return found;
}

/**
 * 资源注册表：发现 agent 目录与项目级目录下的 skills/prompts/themes，
 * 资源清单可刷新；项目本地资源经 trust 门控后才可加载。
 */
export function createResourceRegistry(options: ResourceRegistryOptions): ResourceRegistry {
  let manifest: ResourceManifest = { entries: [], generation: 0 };

  function scan(): ResourceManifest {
    const entries = [
      ...scanRoot(options.agentRoot, "agent"),
      ...(options.projectRoot === undefined ? [] : scanRoot(options.projectRoot, "project")),
    ];
    manifest = { entries, generation: manifest.generation + 1 };
    return manifest;
  }

  return {
    discover() {
      if (manifest.generation === 0) return scan();
      return manifest;
    },
    refresh() {
      return scan();
    },
    load(id) {
      const entry = manifest.entries.find((item) => item.id === id);
      if (entry === undefined) throw new Error(`RESOURCE_NOT_FOUND: ${id}`);
      if (entry.scope === "project") {
        const trusted = options.trust?.isTrusted(entry.root) ?? false;
        if (!trusted) {
          const error = new Error(`TRUST_REQUIRED: ${entry.root}`) as Error & { code: string };
          error.code = "TRUST_REQUIRED";
          throw error;
        }
      }
      // 信任通过后再读取正文；读取失败返回空内容，与发现阶段一致。
      let content = "";
      try {
        content = readFileSync(join(entry.root, RESOURCE_LAYOUT[entry.type].dir, entry.relativePath), "utf8");
      } catch {
        content = "";
      }
      // 解析失败不抛出：以 typed ParseResult 附着，单条坏资源不拖垮其它资源。
      const parsers = options.parsers ?? builtinParsers;
      return { ...entry, content, parse: parseResource(entry, content, parsers) };
    },
  };
}
