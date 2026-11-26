import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceStore } from "./offload";

export interface FileWorkspaceStoreOptions {
  /** workspace:/// URI 区块的持久化根目录；重启后用同一目录可取回。 */
  readonly root: string;
}

interface WorkspaceRecord {
  readonly format: "zeta-workspace-block";
  readonly version: 1;
  readonly uri: string;
  readonly data: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 文件持久 workspace：URI 是逻辑地址，文件名由 URI 的 SHA-256 派生，
 * 不把不受信任的 URI 片段拼进路径，避免目录穿越；JSON 记录自带 uri 校验，避免哈希碰撞串块。
 */
export function createFileWorkspaceStore(options: FileWorkspaceStoreOptions): WorkspaceStore {
  if (typeof options.root !== "string" || options.root.length === 0) {
    throw new Error("workspace store: root required");
  }
  const root = options.root;
  mkdirSync(root, { recursive: true });

  const fileFor = (uri: string): string => {
    if (typeof uri !== "string" || uri.length === 0) throw new Error("workspace store: invalid uri");
    const raw = uri.startsWith("workspace:///") ? uri.slice("workspace:///".length) : uri;
    const safe = raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100) || "block";
    const digest = createHash("sha256").update(uri).digest("hex").slice(0, 24);
    return join(root, `${safe}-${digest}.json`);
  };

  const readRecord = (uri: string): WorkspaceRecord => {
    const parsed: unknown = JSON.parse(readFileSync(fileFor(uri), "utf8"));
    if (
      !isRecord(parsed) ||
      parsed.format !== "zeta-workspace-block" ||
      parsed.version !== 1 ||
      parsed.uri !== uri ||
      !("data" in parsed)
    ) {
      throw new Error("workspace store: invalid record");
    }
    return parsed as unknown as WorkspaceRecord;
  };

  return {
    put(uri, value) {
      const record: WorkspaceRecord = { format: "zeta-workspace-block", version: 1, uri, data: value };
      writeFileSync(fileFor(uri), `${JSON.stringify(record)}\n`, "utf8");
    },
    get(uri) {
      try {
        return readRecord(uri).data;
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") return undefined;
        throw error;
      }
    },
  };
}
