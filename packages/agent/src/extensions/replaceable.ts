/** 可替换声明：同名后到者替换先到者，replaceable 决定能否被接管。 */
export interface Replaceable<T> {
  readonly name: string;
  readonly replaceable: boolean;
  readonly value: T;
}

export interface ReplaceResult<T> {
  /** 最终生效的值（按内置顺序、再按第三方顺序的稳定排列）。 */
  readonly active: readonly T[];
  /** 被第三方整包替换的 name 列表。 */
  readonly replaced: readonly string[];
  /** 尝试替换不可替换内置项而被拒绝的 name 列表。 */
  readonly rejected: readonly string[];
}

/**
 * 解析 replaceable 语义：内置扩展与第三方扩展按 name 归并。
 * - 第三方与内置同名：内置 replaceable=true 才允许接管，否则拒绝。
 * - 同名第三方之间：后到者替换先到者（仍受先到者 replaceable 约束）。
 * - 顺序稳定：内置项保序，第三方新项追加在后。
 */
export function resolveReplaceable<T>(
  builtins: readonly Replaceable<T>[],
  extras: readonly Replaceable<T>[],
): ReplaceResult<T> {
  const replaced: string[] = [];
  const rejected: string[] = [];
  const slots: Array<{ name: string; value: T; replaceable: boolean }> = builtins.map((item) => ({
    name: item.name,
    value: item.value,
    replaceable: item.replaceable,
  }));

  for (const extra of extras) {
    const index = slots.findIndex((slot) => slot.name === extra.name);
    if (index < 0) {
      slots.push({ name: extra.name, value: extra.value, replaceable: extra.replaceable });
      continue;
    }
    const existing = slots[index];
    if (existing === undefined) continue;
    if (!existing.replaceable) {
      rejected.push(extra.name);
      continue;
    }
    slots[index] = { name: extra.name, value: extra.value, replaceable: extra.replaceable };
    if (!replaced.includes(extra.name)) replaced.push(extra.name);
  }

  return {
    active: slots.map((slot) => slot.value),
    replaced,
    rejected,
  };
}
