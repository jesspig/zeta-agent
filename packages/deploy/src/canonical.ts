import { createHash } from "node:crypto";

/**
 * 无歧义配置编码：每段都带类型标签，字符串/数字用长度前缀，
 * 复合值用首次出现的 id + 回指 `R#id`，因此 Date、Map、Set、
 * 循环引用与 undefined 都有唯一表示，且对象键顺序不影响结果。
 */
class CanonicalEncoder {
  private readonly seen = new Map<object, number>();
  private nextId = 0;

  encode(value: unknown): string {
    if (value === undefined) return "U";
    if (value === null) return "N";
    if (value === true) return "T";
    if (value === false) return "F";
    if (typeof value === "bigint") return this.tagged("I", value.toString());
    if (typeof value === "number") return this.tagged("D", Object.is(value, -0) ? "-0" : String(value));
    if (typeof value === "string") return this.tagged("S", JSON.stringify(value));
    if (typeof value === "symbol") return this.tagged("X", `symbol:${String(value.description)}`);
    if (typeof value === "function") return this.tagged("X", `function:${value.name}`);

    const object = value as object;
    const known = this.seen.get(object);
    if (known !== undefined) return `R#${known}`;
    const id = this.nextId++;
    this.seen.set(object, id);

    if (value instanceof Date) {
      return this.tagged("Z", Number.isNaN(value.getTime()) ? "INVALID" : value.toISOString());
    }
    if (value instanceof Map) {
      const pairs = [...value.entries()].map(([key, item]) => ({
        key: this.sortKey(key),
        value: item,
      }));
      pairs.sort((a, b) => compare(a.key, b.key));
      const parts = pairs.map((pair) => pair.key + this.encode(pair.value));
      return `M#${id}[${parts.length}]{${parts.join("")}}`;
    }
    if (value instanceof Set) {
      const items = [...value.values()].map((item) => ({ key: this.sortKey(item), value: item }));
      items.sort((a, b) => compare(a.key, b.key));
      const parts = items.map((item) => this.encode(item.value));
      return `Q#${id}[${parts.length}]{${parts.join("")}}`;
    }
    if (Array.isArray(value)) {
      const parts = value.map((item) => this.encode(item));
      return `A#${id}[${parts.length}]{${parts.join("")}}`;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compare);
    const parts = keys.map((key) => this.tagged("S", JSON.stringify(key)) + this.encode(record[key]));
    return `O#${id}[${parts.length}]{${parts.join("")}}`;
  }

  /** 独立的无共享上下文编码，仅用于为 Map/Set 元素生成与插入顺序无关的排序键。 */
  private sortKey(value: unknown): string {
    return new CanonicalEncoder().encode(value);
  }

  private tagged(tag: string, text: string): string {
    return `${tag}${text.length}:${text}`;
  }
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function canonicalConfigEncoding(config: Readonly<Record<string, unknown>>): string {
  return new CanonicalEncoder().encode(config as unknown);
}

export function computeConfigDigest(config: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(canonicalConfigEncoding(config), "utf8").digest("hex");
}
