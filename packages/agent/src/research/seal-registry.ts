import { atomicWriteFileSync } from "@zeta-agent/security";
import { existsSync, readFileSync } from "node:fs";

/** 跨进程晋升 seal 登记：只保存已由权威 pipeline 签发的键，不保存可伪造的 seal 对象。 */
export interface PromotionSealRegistry {
  has(key: string): boolean;
  record(key: string): void;
}

interface RegistryFile {
  readonly schemaVersion: 1;
  readonly keys: readonly string[];
}

export function promotionSealKey(
  identityDigest: string,
  candidateId: string,
  fitness: number | string
): string {
  return `${identityDigest}\0${candidateId}\0${String(fitness)}`;
}

export function createFilePromotionSealRegistry(filePath: string): PromotionSealRegistry {
  const keys = new Set<string>();
  if (existsSync(filePath)) {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      (parsed as RegistryFile).schemaVersion !== 1 ||
      !Array.isArray((parsed as RegistryFile).keys) ||
      !(parsed as RegistryFile).keys.every((key) => typeof key === "string" && key.length > 0)
    ) {
      throw new Error("INVALID_PROMOTION_SEAL_REGISTRY");
    }
    for (const key of (parsed as RegistryFile).keys) keys.add(key);
  }
  const persist = (): void => {
    const file: RegistryFile = { schemaVersion: 1, keys: [...keys] };
    atomicWriteFileSync(filePath, JSON.stringify(file));
  };
  if (!existsSync(filePath)) persist();
  return {
    has: (key) => keys.has(key),
    record(key) {
      if (typeof key !== "string" || key.length === 0) throw new Error("INVALID_PROMOTION_SEAL_KEY");
      if (keys.has(key)) return;
      keys.add(key);
      persist();
    },
  };
}
