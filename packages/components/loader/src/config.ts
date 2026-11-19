import type { FiberId } from "@zeta-agent/framework";

export interface JsExpr {
  readonly __jsExpr: string;
}

export type Disabled = boolean | JsExpr;

export interface Entry {
  readonly id: FiberId;
  readonly name: string;
  readonly config?: unknown;
  readonly isolate?: Readonly<Record<string, true | string>>;
  readonly intercept?: Readonly<Record<string, unknown>>;
  readonly inject?: readonly string[] | Readonly<Record<string, string>>;
  readonly disabled?: Disabled;
  readonly group?: boolean | null;
  readonly volatile?: boolean;
}

export type LayerKind = "bundle" | "profile" | "patch" | "overlay";
export const LAYER_ORDER: readonly LayerKind[] = ["bundle", "profile", "patch", "overlay"];

export type PatchOp =
  | { readonly op: "insert"; readonly entry: Entry }
  | { readonly op: "set"; readonly entry: Entry }
  | { readonly op: "remove"; readonly id: string };

export interface ConfigLayer {
  readonly kind: LayerKind;
  readonly source: string;
  readonly file?: boolean;
  readonly ops: readonly PatchOp[];
}

export interface EntryOwner {
  readonly id: FiberId;
  readonly source: string;
  readonly layer: LayerKind;
  readonly file: boolean;
}

export interface DerivedConfig {
  readonly entries: readonly Entry[];
  readonly owners: ReadonlyMap<FiberId, EntryOwner>;
  readonly warnings: readonly string[];
}

export interface SerializedConfig {
  readonly version: 1;
  readonly entries: ReadonlyArray<Entry & { readonly __owner: EntryOwner }>;
  readonly warnings: readonly string[];
}

export function isJsExpr(value: unknown): value is JsExpr {
  return typeof value === "object" && value !== null && typeof (value as JsExpr).__jsExpr === "string";
}

function assertEntry(entry: Entry): void {
  if (typeof entry.id !== "string" || entry.id.length === 0) throw new Error("INVALID_ENTRY_ID");
  if (typeof entry.name !== "string" || entry.name.length === 0) throw new Error("INVALID_ENTRY_NAME");
  if (entry.isolate !== undefined) {
    if (typeof entry.isolate !== "object" || entry.isolate === null || Array.isArray(entry.isolate)) {
      throw new Error("INVALID_ISOLATE");
    }
    for (const value of Object.values(entry.isolate)) {
      if (value !== true && typeof value !== "string") throw new Error("INVALID_ISOLATE");
    }
  }
  if (entry.disabled !== undefined && typeof entry.disabled !== "boolean" && !isJsExpr(entry.disabled)) {
    throw new Error("INVALID_DISABLED");
  }
  if (entry.group === true) {
    if (!Array.isArray(entry.config)) throw new Error("INVALID_GROUP_CONFIG");
    for (const child of entry.config as unknown[]) {
      if (typeof child !== "object" || child === null) throw new Error("INVALID_GROUP_CONFIG");
      assertEntry(child as Entry);
    }
  }
}

export function moduleSpecifier(entry: Entry): string {
  assertEntry(entry);
  return entry.name;
}

export function isGroup(entry: Entry): boolean {
  return entry.group === true;
}

export function subEntries(entry: Entry): readonly Entry[] {
  if (!isGroup(entry)) throw new Error("NOT_GROUP");
  if (!Array.isArray(entry.config)) throw new Error("INVALID_GROUP_CONFIG");
  for (const child of entry.config as unknown[]) {
    if (typeof child !== "object" || child === null) throw new Error("INVALID_GROUP_CONFIG");
    assertEntry(child as Entry);
  }
  return entry.config as Entry[];
}

export function childId(parent: Entry, child: Entry): string {
  assertEntry(parent);
  assertEntry(child);
  return `${parent.id}:${child.id}`;
}

export function isolateValue(entry: Entry, service: string): true | string | undefined {
  return entry.isolate?.[service];
}

function parseLiteral(text: string): unknown {
  const token = text.trim();
  if (token === "true") return true;
  if (token === "false") return false;
  if (token === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(token)) return Number(token);
  if (/^(["'])[^"']*\1$/.test(token)) return token.slice(1, -1);
  throw new Error(`INVALID_JS_EXPR_LITERAL ${token}`);
}

export function evalJsExpr(expr: JsExpr, scope: Readonly<Record<string, unknown>> = {}): boolean {
  if (!isJsExpr(expr)) throw new Error("INVALID_JS_EXPR");
  const source = expr.__jsExpr.trim();
  const negated = source.startsWith("!");
  const body = (negated ? source.slice(1) : source).trim();
  const comparison = /^([A-Za-z_$][\w$]*)\s*(===|!==)\s*(.+)$/.exec(body);
  let result: boolean;
  if (comparison) {
    const name = comparison[1]!;
    const operator = comparison[2]!;
    const literal = parseLiteral(comparison[3]!);
    const equal = scope[name] === literal;
    result = operator === "===" ? equal : !equal;
  } else if (/^[A-Za-z_$][\w$]*$/.test(body)) {
    result = Boolean(scope[body]);
  } else {
    throw new Error(`INVALID_JS_EXPR ${source}`);
  }
  return negated ? !result : result;
}

export function isDisabled(entry: Entry, scope: Readonly<Record<string, unknown>> = {}): boolean {
  const value = entry.disabled;
  if (value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (isJsExpr(value)) return evalJsExpr(value, scope);
  throw new Error("INVALID_DISABLED");
}

function decideWinner(previous: EntryOwner, incoming: EntryOwner): EntryOwner {
  if (previous.file !== incoming.file) return previous.file ? previous : incoming;
  return incoming;
}

export function deriveConfig(layers: readonly ConfigLayer[]): DerivedConfig {
  const ordered = [...layers].sort((a, b) => LAYER_ORDER.indexOf(a.kind) - LAYER_ORDER.indexOf(b.kind));
  const entries = new Map<FiberId, Entry>();
  const owners = new Map<FiberId, EntryOwner>();
  const warnings: string[] = [];

  for (const current of ordered) {
    if (!LAYER_ORDER.includes(current.kind)) throw new Error("INVALID_LAYER");
    for (const op of current.ops) {
      if (op.op === "remove") {
        if (entries.delete(op.id)) owners.delete(op.id);
        continue;
      }
      assertEntry(op.entry);
      const id = op.entry.id;
      const existing = entries.get(id);
      const owner: EntryOwner = {
        id,
        source: current.source,
        layer: current.kind,
        file: current.file === true,
      };
      if (!existing) {
        entries.set(id, op.entry);
        owners.set(id, owner);
        continue;
      }
      if (op.op === "set" && existing.name !== op.entry.name) {
        warnings.push(`NAME_MISMATCH ${id} ${current.source} expected ${existing.name} got ${op.entry.name}`);
        continue;
      }
      const previous = owners.get(id)!;
      const winner = decideWinner(previous, owner);
      if (winner === owner) {
        entries.set(id, op.entry);
        owners.set(id, owner);
        warnings.push(`CONFLICT ${id} ${owner.source} wins over ${previous.source}${owner.file ? " (file wins)" : ""}`);
      } else {
        warnings.push(`CONFLICT ${id} ${previous.source} wins over ${owner.source}${previous.file ? " (file wins)" : ""}`);
      }
    }
  }

  const sorted = [...entries.values()].sort((a, b) => a.id.localeCompare(b.id));
  const sortedOwners = new Map<FiberId, EntryOwner>();
  for (const item of sorted) sortedOwners.set(item.id, owners.get(item.id)!);
  return { entries: sorted, owners: sortedOwners, warnings };
}

export function dumpConfig(derived: DerivedConfig): SerializedConfig {
  return {
    version: 1,
    entries: derived.entries.map((item) => {
      const owner = derived.owners.get(item.id);
      if (!owner) throw new Error("MISSING_ENTRY_OWNER");
      return { ...item, __owner: owner };
    }),
    warnings: [...derived.warnings],
  };
}
