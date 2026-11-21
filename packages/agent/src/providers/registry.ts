import { MODELS, type Model } from "./catalog.generated";

export interface ListOptions {
  readonly provider?: string;
  readonly input?: string;
}

export interface ModelRegistry {
  /** 按完整 id / 别名 / provider 侧模型名解析；返回 undefined 表示未知。 */
  resolve(reference: string): Model | undefined;
  /** 列出模型，可按 provider 与 input 能力过滤。 */
  list(options?: ListOptions): readonly Model[];
  /** 检测到的重复别名（首个注册项胜出）。 */
  readonly duplicateAliases: readonly string[];
}

export function createModelRegistry(models: readonly Model[] = MODELS): ModelRegistry {
  const byId = new Map<string, Model>();
  const byAlias = new Map<string, Model>();
  const byName = new Map<string, Model>();
  const duplicateAliases: string[] = [];

  for (const model of models) {
    byId.set(model.id, model);
    const nameKey = model.name.toLowerCase();
    if (!byName.has(nameKey)) byName.set(nameKey, model);
    for (const alias of model.aliases) {
      const key = alias.toLowerCase();
      if (byAlias.has(key)) {
        duplicateAliases.push(alias);
        continue;
      }
      byAlias.set(key, model);
    }
  }

  return {
    resolve(reference: string): Model | undefined {
      if (typeof reference !== "string" || reference.length === 0) return undefined;
      const key = reference.toLowerCase();
      return byId.get(reference) ?? byId.get(key) ?? byAlias.get(key) ?? byName.get(key);
    },
    list(options?: ListOptions): readonly Model[] {
      return models.filter((model) => {
        if (options?.provider !== undefined && model.provider !== options.provider) return false;
        if (options?.input !== undefined && !model.input.includes(options.input)) return false;
        return true;
      });
    },
    duplicateAliases,
  };
}
