export type ThemeName = "system" | "dark" | "light";
export type ColorToken = "accent" | "text" | "border" | "muted" | "error";

const REQUIRED_TOKENS: readonly ColorToken[] = ["accent", "text", "border", "muted", "error"];

type Palette = Readonly<Record<ColorToken, string>>;

const DARK_PALETTE: Palette = {
  accent: "#7ee787",
  text: "#c9d1d9",
  border: "#30363d",
  muted: "#8b949e",
  error: "#ff7b72",
};

const LIGHT_PALETTE: Palette = {
  accent: "#1a7f37",
  text: "#1f2328",
  border: "#d0d7de",
  muted: "#656d76",
  error: "#cf222e",
};

export interface Theme {
  readonly name: string;
  color(token: ColorToken): string;
}

export interface ThemeRegistry {
  tokens(): readonly ColorToken[];
  has(name: string): boolean;
  theme(name: string): Theme;
  active(): string;
  activeTheme(): Theme;
  setActive(name: string): void;
  resolveSystem(): "dark" | "light";
  resolve(name: string): "dark" | "light";
  define(name: string, definition: unknown): void;
  subscribe(listener: () => void): () => void;
}

function isValidPalette(value: unknown): value is Partial<Palette> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.values(record).every((color) => typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color));
}

/** IF-08 token 化主题注册表：system/dark/light、自动配对、signal 精细热重载。 */
export function createThemeRegistry(options: { readonly prefers?: "dark" | "light" } = {}): ThemeRegistry {
  const listeners = new Set<() => void>();
  const themes = new Map<string, Palette>([
    ["dark", DARK_PALETTE],
    ["light", LIGHT_PALETTE],
  ]);
  let active: string = "dark";
  const prefers = options.prefers ?? "dark";

  function makeTheme(name: string, palette: Palette): Theme {
    return {
      name,
      color(token) {
        return palette[token] ?? DARK_PALETTE[token];
      },
    };
  }

  function resolve(name: string): "dark" | "light" {
    if (name === "light") return "light";
    if (name === "system") return prefers;
    return "dark";
  }

  return {
    tokens: () => [...REQUIRED_TOKENS],
    has: (name) => themes.has(name) || name === "system",
    theme(name) {
      const resolved = resolve(name);
      return makeTheme(name, themes.get(resolved) ?? DARK_PALETTE);
    },
    active: () => active,
    activeTheme() {
      return this.theme(active);
    },
    setActive(name) {
      if (name !== "system" && !themes.has(name)) return;
      if (active === name) return;
      active = name;
      for (const listener of [...listeners]) listener();
    },
    resolveSystem: () => prefers,
    resolve,
    define(name, definition) {
      if (typeof definition !== "object" || definition === null) return;
      const colors = (definition as { colors?: unknown }).colors;
      if (!isValidPalette(colors)) return;
      themes.set(name, { ...DARK_PALETTE, ...colors });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
