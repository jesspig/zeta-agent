import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ResourceEntry, ResourceType } from "@zeta-agent/agent";
import { EMBEDDED_ASSETS, EMBEDDED_MANIFEST } from "./embedded-assets.generated";

interface CatalogItem {
  readonly id: string;
  readonly resourceId: string;
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface ResourceCatalog {
  readonly schema: string;
  readonly prompts: readonly CatalogItem[];
  readonly skills: readonly CatalogItem[];
  readonly schemaFiles: readonly CatalogItem[];
}

const CATALOG_SCHEMA = "zeta-local-resources/1";

/**
 * 把单文件内嵌的 prompts/skills/schema 解码为 ResourceEntry，交给同一 ResourceRegistry。
 * 每条都按嵌入 manifest 做 bytes + SHA-256 校验，损坏即失败关闭，不用合成 marker 冒充。
 */
export function embeddedResources(): readonly ResourceEntry[] {
  const catalogPath = EMBEDDED_ASSETS["resource-catalog"];
  if (catalogPath === undefined) throw new Error("EMBEDDED_CATALOG_MISSING");
  let catalog: ResourceCatalog;
  try {
    catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as ResourceCatalog;
  } catch (error) {
    throw new Error(`EMBEDDED_CATALOG_INVALID: ${String((error as Error).message)}`);
  }
  if (catalog.schema !== CATALOG_SCHEMA) throw new Error(`EMBEDDED_CATALOG_SCHEMA_MISMATCH: ${catalog.schema}`);

  const byId = new Map(EMBEDDED_MANIFEST.embedded.map((item) => [item.id, item]));
  const groups: readonly (readonly [ResourceType, readonly CatalogItem[]])[] = [
    ["prompt", catalog.prompts ?? []],
    ["skill", catalog.skills ?? []],
    ["schema", catalog.schemaFiles ?? []],
  ];
  const entries: ResourceEntry[] = [];
  for (const [type, items] of groups) {
    for (const item of items) {
      const declared = byId.get(item.resourceId);
      if (declared === undefined) throw new Error(`EMBEDDED_RESOURCE_MISSING: ${item.resourceId}`);
      const assetPath = EMBEDDED_ASSETS[item.resourceId];
      if (assetPath === undefined) throw new Error(`EMBEDDED_ASSET_MISSING: ${item.resourceId}`);
      const content = readFileSync(assetPath, "utf8");
      const bytes = Buffer.byteLength(content, "utf8");
      const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
      if (
        bytes !== declared.bytes ||
        sha256 !== declared.sha256 ||
        bytes !== item.bytes ||
        sha256 !== item.sha256 ||
        declared.path !== item.path
      ) {
        throw new Error(`EMBEDDED_RESOURCE_DIGEST_MISMATCH: ${item.resourceId}`);
      }
      entries.push({
        id: `agent:${type}:${declared.path}`,
        type,
        scope: "agent",
        content,
        root: "embedded",
        relativePath: declared.path,
        embedded: true,
      });
    }
  }
  return entries;
}
