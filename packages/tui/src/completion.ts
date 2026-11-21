export interface CompletionProvider {
  complete(prefix: string): Promise<readonly string[]>;
}

export interface CompletionResult {
  readonly items: readonly string[];
  readonly stale: boolean;
}

export type CompletionProviders = Readonly<Record<string, CompletionProvider>>;

/** 连续子序列模糊匹配分数，越大越匹配。 */
export function fuzzyScore(query: string, candidate: string): number {
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  let score = 0;
  let index = 0;
  for (const char of q) {
    const found = c.indexOf(char, index);
    if (found === -1) return -1;
    score += found === index ? 3 : 1;
    index = found + 1;
  }
  if (c.startsWith(q)) score += 5;
  return score;
}

/** IF-09 补全引擎：多 provider、模糊排序、generation 守卫丢弃陈旧异步结果。 */
export function createCompletion(providers: CompletionProviders) {
  const generations = new Map<string, number>();

  return {
    async complete(prefix: string, source: string): Promise<CompletionResult> {
      const current = (generations.get(source) ?? 0) + 1;
      generations.set(source, current);
      const provider = providers[source];
      if (!provider) return { items: [], stale: false };
      const items = await provider.complete(prefix);
      if (current !== generations.get(source)) return { items: [], stale: true };
      const ranked = [...items].sort((a, b) => {
        const scoreA = fuzzyScore(prefix, a);
        const scoreB = fuzzyScore(prefix, b);
        return scoreB - scoreA;
      });
      return { items: ranked, stale: false };
    },
    fuzzy(query: string, candidates: readonly string[]): readonly string[] {
      return [...candidates]
        .filter((candidate) => fuzzyScore(query, candidate) >= 0)
        .sort((a, b) => fuzzyScore(query, b) - fuzzyScore(query, a));
    },
  };
}
