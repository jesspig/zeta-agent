/**
 * 共享 canonical 的多个 maker 变体中选择确切条目的纯函数。
 * 优先模型键与 canonical bare 一致的条目，避免由输入顺序决定元数据。
 */
export function pickCanonicalMakerEntry(entries, canonical, makerPrefix, bareOf) {
  const makerEntries = entries.filter((e) => e.providerId === makerPrefix);
  const canonBare = bareOf(canonical);
  return makerEntries.find((e) => bareOf(e.modelKey) === canonBare)
    ?? makerEntries.find((e) => e.modelKey === canonical)
    ?? makerEntries[0];
}
