import {
  MODELS_DEV_MODELS,
  CANONICAL_META,
  FREE_VARIANT_ALIASES,
  LISTED_BARE_IDS,
  type ModelMeta,
} from "./models-dev.generated";

/** 模型选项：字段分列供 TUI 多列对齐展示，effort 为可选思考强度档位。 */
export interface ModelOption {
  readonly value: string;
  readonly name: string;
  readonly context: string;
  readonly price: string;
  readonly effort: readonly string[];
  readonly reasoning: boolean;
  readonly vision: boolean;
  readonly group: string;
}

const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function normalizeEffort(effort: readonly string[] | undefined): readonly string[] {
  if (effort === undefined || effort.length === 0) return [];
  return [...effort].sort((a, b) => {
    const ai = EFFORT_ORDER.indexOf(a as (typeof EFFORT_ORDER)[number]);
    const bi = EFFORT_ORDER.indexOf(b as (typeof EFFORT_ORDER)[number]);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });
}

const bareOf = (id: string): string => id.slice(id.lastIndexOf("/") + 1);

/**
 * SameModel（参考 magpie internal/catalog/samemodel.go）：小写、去 provider 前缀、
 * 空格/_/- 折叠为单个 -、版本点/ p 转连字符、去尾部快照日期。
 * 注意：:flash、:thinking 等变体后缀保留；不折叠 flash 与 flashx。
 */
function sameModel(id: string): string {
  let key = id.trim().toLowerCase();
  const slash = key.lastIndexOf("/");
  if (slash >= 0) key = key.slice(slash + 1);
  key = key.replace(/[\s_]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  key = key.replace(/(\d)[.p](\d)/g, "$1-$2");
  key = key.replace(/[-@]?\d{8}$/, "").replace(/-+$/g, "");
  return key;
}

/** SameModel 拼写折叠索引：same key -> 出现最多的官方条目（歧义丢弃）。 */
const SAME_SPELLINGS: ReadonlyMap<string, string> = (() => {
  const counts = new Map<string, Map<string, number>>();
  for (const meta of Object.values(MODELS_DEV_MODELS)) {
    const key = sameModel(meta.id);
    if (key.length === 0) continue;
    if (!counts.has(key)) counts.set(key, new Map());
    const bySpell = counts.get(key)!;
    bySpell.set(meta.id, (bySpell.get(meta.id) ?? 0) + 1);
  }
  const out = new Map<string, string>();
  for (const [key, bySpell] of counts) {
    if (bySpell.size !== 1) continue; // 多种拼写 -> 有歧义，不折叠
    out.set(key, [...bySpell.keys()][0]!);
  }
  return out;
})();

/** canonical 的 same 拼写索引：sameModel(canonical) -> 元数据，解决大小写/分隔符差异。 */
const CANONICAL_SAME: ReadonlyMap<string, string> = (() => {
  const out = new Map<string, string>();
  for (const key of Object.keys(CANONICAL_META)) {
    const norm = sameModel(key);
    if (norm.length > 0 && !out.has(norm)) out.set(norm, key);
  }
  return out;
})();

/** magpie 式查找链：精确 bare -> 精确 canonical -> 保守 same 拼写。listed id 不做别名猜测。 */
function lookupMeta(id: string): ModelMeta | undefined {
  const bare = bareOf(id);
  // 免费变体（beam-free / hy4-flash-free 等）：本来不是官方 bare id，但 models.dev
  // 里带 free 标记的条目声明了 canonical，可解析到官方元数据（含上下文/推理/价格 free）。
  const freeVariant = FREE_VARIANT_ALIASES[bare];
  if (freeVariant !== undefined) {
    // 免费变体一律显示 free（元数据借官方条目，但价格强制为 0）。
    return { ...freeVariant, cost: { input: 0, output: 0 } };
  }
  const canonical = CANONICAL_META[id] ?? CANONICAL_META[bare];
  const exact = MODELS_DEV_MODELS[bare] ?? MODELS_DEV_MODELS[id];
  // 精确 bare id：若它来自 canonical 前缀所指的 maker，则是官方模型自身（magpie listed 守卫）。
  // glm-5.3-flash / flashx 的 maker 都是 zhipuai，虽共享 canonical 却是两个价格不同的模型。
  const makerPrefix = exact?.canonical?.includes("/") ? exact.canonical.split("/")[0] : undefined;
  if (exact !== undefined && (makerPrefix === undefined || makerPrefix === exact.provider)) {
    return exact;
  }
  // bare 条目来自别的实验室（中转商，如 nvidia 列的 deepseek-v4.1-flash / minimax-m3.1-flash），
  // 用 canonical 别名解析到 maker 官方元数据（多数投票价），而非中转商乱价。
  if (canonical !== undefined) return canonical;
  // 大小写/分隔符差异：用 canonical 的 same 拼写匹配（minimax-m3.1-flash -> minimax/MiniMax-M3.1-Flash）。
  const canonSameKey = CANONICAL_SAME.get(sameModel(id));
  if (canonSameKey !== undefined) return CANONICAL_META[canonSameKey];
  if (exact !== undefined) return exact;
  // ③ listed/canonical 的 id 是自身，不再猜测（magpie 守卫）。
  if (LISTED_BARE_IDS.has(bare)) return undefined;
  // ④ 保守 SameModel 拼写折叠（如 5-3 vs 5.3），仅当无歧义。
  const same = sameModel(id);
  const spelling = SAME_SPELLINGS.get(same);
  return spelling === undefined ? undefined : MODELS_DEV_MODELS[spelling];
}

function formatTokens(tokens: number): string {
  if (tokens <= 0) return "-";
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}K` : `${tokens}`;
}

function formatPrice(meta: ModelMeta): string {
  if (meta.cost === undefined) return "-";
  const { input, output } = meta.cost;
  if (input === 0 && output === 0) return "free";
  return `$${input}/${output}`;
}

/** 用 models.dev 元数据描述 live 模型；名字用 vendor 实际 id，不猜测变体。 */
export function decorateModels(liveIds: readonly string[]): readonly ModelOption[] {
  return liveIds.map((id) => {
    const meta = lookupMeta(id);
    if (meta === undefined) {
      return {
        value: id,
        name: bareOf(id),
        context: "-",
        price: "-",
        effort: [],
        reasoning: false,
        vision: false,
        group: "Custom",
      };
    }
    return {
      value: id,
      name: bareOf(id), // 显示 vendor 实际返回的 id，避免把 flash 误标成 flashx
      context: formatTokens(meta.context),
      price: formatPrice(meta),
      effort: normalizeEffort(meta.effort),
      reasoning: meta.reasoning === true,
      vision: meta.input?.includes("image") === true,
      group: meta.provider,
    };
  });
}
