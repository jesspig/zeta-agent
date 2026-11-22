// 从 models.dev/api.json 抓取官方实验室模型元数据，生成内置精简 JSON。
// 运行：bun packages/agent/scripts/generate-models-dev.mjs
//
// 设计（参考 magpie internal/catalog）：
// - 要的是"模型信息"（价格/上下文/多模态），不是供应商信息；协议由适配器覆盖。
// - 官方实验室 = canonical_model_id 前缀指向的 provider；只保留其自有条目。
// - 两套索引：
//   * MODELS_BY_BARE  — bare id（glm-5.3-flash 与 glm-5.3-flashx 各自独立，不按 canonical 去重）
//   * CANONICAL_META  — canonical id -> 官方实验室元数据（别名回退匹配；价格取 maker 官方值）
// - 匹配时：精确 bare -> 精确 canonical（含快照日期剥离）-> 保守 SameModel 拼写折叠，且
//   凡 models.dev 已按原样列出的 id 绝不作为别名（magpie 的 listed/canonical 守卫）。
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pickCanonicalMakerEntry } from "./canonical-selection.js";

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, "../src/providers/models-dev.generated.ts");
const url = process.env.MODELS_DEV_URL ?? "https://models.dev/api.json";

const response = await fetch(url, { headers: { "User-Agent": "zeta-agent-catalog-builder" } });
if (!response.ok) throw new Error(`models.dev HTTP ${response.status}`);
const raw = await response.json();

const bareOf = (id) => id.slice(id.lastIndexOf("/") + 1);

// 1) 官方实验室 = canonical 前缀且有自己 provider 条目的 id。
const labIds = new Set();
for (const provider of Object.values(raw)) {
  for (const model of Object.values(provider?.models ?? {})) {
    const canonical = model?.canonical_model_id;
    if (typeof canonical === "string" && canonical.includes("/")) labIds.add(canonical.split("/")[0]);
  }
}

// 2) 所有被 models.dev 按原样列出的 bare id（守卫：列出的 id 是自身，不作别名）。
const listedBare = new Set();
for (const provider of Object.values(raw)) {
  for (const mid of Object.keys(provider?.models ?? {})) listedBare.add(bareOf(mid));
}

function metaOf(mid, model, lab) {
  const bare = bareOf(mid);
  const cost = model.cost;
  return {
    id: `${lab}/${bare}`,
    name: model.name ?? bare,
    provider: lab,
    ...(model.family !== undefined ? { family: model.family } : {}),
    ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
    ...(model.tool_call !== undefined ? { toolCall: model.tool_call } : {}),
    ...(model.modalities?.input !== undefined ? { input: model.modalities.input } : {}),
    ...(model.modalities?.output !== undefined ? { output: model.modalities.output } : {}),
    context: model.limit?.input ?? model.limit?.context ?? 0,
    maxOutput: model.limit?.output ?? 0,
    ...(cost !== undefined
      ? { cost: { input: cost.input ?? 0, output: cost.output ?? 0, ...(cost.cache_read !== undefined ? { cacheRead: cost.cache_read } : {}) } }
      : {}),
    ...(model.knowledge !== undefined ? { knowledge: model.knowledge } : {}),
    ...(model.release_date !== undefined ? { released: model.release_date } : {}),
    ...(() => {
      const effortOption = (model.reasoning_options ?? []).find((option) => option?.type === "effort");
      const values = effortOption?.values;
      return Array.isArray(values) && values.length > 0 ? { effort: values } : {};
    })(),
    ...(typeof model.canonical_model_id === "string" && model.canonical_model_id.length > 0 ? { canonical: model.canonical_model_id } : {}),
  };
}

// 3) 官方实验室自有条目，按 bare id 索引（flash / flashx 各自独立）。
// 同一个 bare 被多家实验室发布时（中转商误判为 lab），优先 canonical 自指
// （canonical === <lab>/<bare>）的那家，即真正的 maker（magpie canonical 守卫）。
const models = {};
const isSelfCanonical = (lab, bare, model) =>
  typeof model.canonical_model_id === "string" && bareOf(model.canonical_model_id) === bare && model.canonical_model_id === `${lab}/${bare}`;
for (const id of labIds) {
  const provider = raw[id];
  if (provider === undefined || provider === null) continue;
  for (const [mid, model] of Object.entries(provider.models ?? {})) {
    if (model === undefined || model === null) continue;
    const bare = bareOf(mid);
    const existing = models[bare];
    if (existing === undefined || (!isSelfCanonical(id, bare, existing) && isSelfCanonical(id, bare, model))) {
      models[bare] = metaOf(mid, model, id);
    }
  }
}

// 4) canonical id -> 元数据。优先取官方实验室自有条目（maker 官方价格）；
//    其余 canonical 仅在多个 provider 价格一致时才采纳（magpie canonicallyPriced 思想）。
const canonicalVotes = new Map();
for (const [providerId, provider] of Object.entries(raw)) {
  for (const [modelKey, model] of Object.entries(provider?.models ?? {})) {
    const c = model?.canonical_model_id;
    if (typeof c !== "string" || c.length === 0) continue;
    if (!canonicalVotes.has(c)) canonicalVotes.set(c, []);
    canonicalVotes.get(c).push({ model, providerId, modelKey });
  }
}
const canonicalMeta = {};
for (const [canonical, entries] of canonicalVotes) {
  const canonBare = bareOf(canonical);
  const makerPrefix = canonical.split("/")[0];
  // maker 自有条目优先；共享 canonical 的多个变体按模型键精确匹配，避免输入顺序影响。
  const maker = pickCanonicalMakerEntry(entries, canonical, makerPrefix, bareOf);
  if (maker !== undefined) {
    const official = metaOf(canonical, maker.model, makerPrefix);
    canonicalMeta[canonical] = official;
    canonicalMeta[canonBare] = official;
    continue;
  }
  // 无 maker 条目时按价格多数投票（magpie vote 思想），取出现最多的价格对应的官方条目。
  const byPrice = new Map();
  for (const e of entries) {
    const key = JSON.stringify(e.model.cost ?? null);
    byPrice.set(key, (byPrice.get(key) ?? 0) + 1);
  }
  const top = [...byPrice.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top !== undefined) {
    const chosen = entries.find((e) => JSON.stringify(e.model.cost ?? null) === top[0]);
    if (chosen !== undefined) {
      const official = metaOf(canonical, chosen.model, chosen.providerId);
      canonicalMeta[canonical] = official;
      canonicalMeta[canonBare] = official;
    }
  }
}

// 5) 免费变体别名：免费（cost 0/0）的渠道 id（如 beam-free / hy4-flash-free /
//    longcat-2.5-free）本身不是 models.dev 的 bare id，但其 canonical 指向官方模型。
//    把这些变体 id 映射到 canonical 官方元数据，让它们也能显示上下文/思考强度/价格。
const freeVariantAliases = {};
for (const [providerId, provider] of Object.entries(raw)) {
  for (const [mid, model] of Object.entries(provider?.models ?? {})) {
    const cost = model?.cost;
    const isFree = cost !== undefined && (cost.input ?? 0) === 0 && (cost.output ?? 0) === 0;
    const canonical = model?.canonical_model_id;
    if (!isFree || typeof canonical !== "string" || canonical.length === 0) continue;
    const official = canonicalMeta[canonical];
    if (official === undefined) continue;
    const bare = bareOf(mid);
    // 只索引带 free 标记的变体 id（:free / -free / _free），避免污染普通 id。
    if (!/(?:^|[-_ :])free(?:[:]|$)/i.test(mid)) continue;
    if (freeVariantAliases[bare] === undefined) freeVariantAliases[bare] = official;
  }
}

const output = `// AUTO-GENERATED by packages/agent/scripts/generate-models-dev.mjs — DO NOT EDIT.
// Source: https://models.dev/api.json — 官方实验室模型元数据 + canonical 别名索引。
// 仅元数据：价格 / 上下文 / 输出 / 多模态 / 推理 / 工具调用。不内置任何供应商或协议。
export interface ModelMeta {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly family?: string;
  readonly reasoning?: boolean;
  readonly toolCall?: boolean;
  readonly input?: readonly string[];
  readonly output?: readonly string[];
  readonly context: number;
  readonly maxOutput: number;
  readonly cost?: { readonly input: number; readonly output: number; readonly cacheRead?: number };
  readonly knowledge?: string;
  readonly released?: string;
  readonly effort?: readonly string[];
  readonly canonical?: string;
}

/** 官方实验室模型，按 bare id 索引（不同变体各自独立）。 */
export const MODELS_DEV_MODELS: Readonly<Record<string, ModelMeta>> = ${JSON.stringify(models, null, 2)} as const;

/** models.dev 按原样列出的 bare id —— 守卫：这些 id 是自身，不作为别名猜测。 */
export const LISTED_BARE_IDS: ReadonlySet<string> = new Set(${JSON.stringify([...listedBare])});

/** canonical id / bare canonical -> 官方元数据（别名回退匹配）。 */
export const CANONICAL_META: Readonly<Record<string, ModelMeta>> = ${JSON.stringify(canonicalMeta, null, 2)} as const;

/** 免费变体 id（含 free 标记）-> 官方元数据，使免费模型也能显示上下文/思考强度/价格。 */
export const FREE_VARIANT_ALIASES: Readonly<Record<string, ModelMeta>> = ${JSON.stringify(freeVariantAliases, null, 2)} as const;
`;

writeFileSync(outPath, output, "utf8");
console.log(`generated ${outPath} (${labIds.size} labs, ${Object.keys(models).length} bare models, ${Object.keys(canonicalMeta).length} canonical entries)`);
