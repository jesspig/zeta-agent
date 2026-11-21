import { generateOklchPalette, SEMANTIC_TOKENS, type GeneratedPalette, type TerminalPaletteInput } from "./theme-generator";

export type ThemeName = "system" | "dark" | "light";
export type ColorToken = (typeof SEMANTIC_TOKENS)[number];

const REQUIRED_TOKENS: readonly ColorToken[] = SEMANTIC_TOKENS;

type Palette = Readonly<GeneratedPalette>;

const DARK_BASE: Partial<Palette> = {
  accent: "#7ee787",
  text: "#c9d1d9",
  border: "#30363d",
  muted: "#8b949e",
  error: "#ff7b72",
  info: "#58a6ff",
  warning: "#d29922",
  thinking: "#d2a8ff",
};

const LIGHT_BASE: Partial<Palette> = {
  accent: "#1a7f37",
  text: "#1f2328",
  border: "#d0d7de",
  muted: "#656d76",
  error: "#cf222e",
  info: "#0969da",
  warning: "#9a6700",
  thinking: "#8250df",
};

const DEFAULT_DARK_INPUT: TerminalPaletteInput = {
  foreground: "#c9d1d9",
  background: "#0d1117",
  ansi: ["#000000", "#ff5555", "#55ff55", "#ffff55", "#5555ff", "#ff55ff", "#55ffff", "#aaaaaa"],
};
const DEFAULT_LIGHT_INPUT: TerminalPaletteInput = {
  foreground: "#1f2328",
  background: "#ffffff",
  ansi: ["#000000", "#cf222e", "#1a7f37", "#9a6700", "#0969da", "#8250df", "#1a7f8f", "#656d76"],
};

function buildBase(input: TerminalPaletteInput, overrides: Partial<Palette>): Palette {
  return { ...generateOklchPalette(input), ...overrides };
}

const DARK_PALETTE: Palette = buildBase(DEFAULT_DARK_INPUT, DARK_BASE);
const LIGHT_PALETTE: Palette = buildBase(DEFAULT_LIGHT_INPUT, LIGHT_BASE);

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
  /** 注入终端调色板，重新派生 system 主题；返回是否发生变化。 */
  setSystemPalette(input: TerminalPaletteInput): boolean;
  subscribe(listener: () => void): () => void;
}

function isValidPalette(value: unknown): value is Partial<Palette> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.values(record).every((color) => typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color));
}

function paletteSignature(input: TerminalPaletteInput): string {
  return `${input.foreground}|${input.background}|${input.ansi.join(",")}`;
}

/** IF-08 token 化主题注册表：system/dark/light、自动配对、fallback 链与 signal 精细热重载。 */
export function createThemeRegistry(options: { readonly prefers?: "dark" | "light" } = {}): ThemeRegistry {
  const listeners = new Set<() => void>();
  const themes = new Map<string, Partial<Palette>>([
    ["dark", DARK_PALETTE],
    ["light", LIGHT_PALETTE],
  ]);
  let active: string = "dark";
  let prefers = options.prefers ?? "dark";
  let systemSignature = paletteSignature(DEFAULT_DARK_INPUT);
  let systemColors: Palette = generateOklchPalette(DEFAULT_DARK_INPUT);

  /** fallback 链：自定义主题 > 基础调色板 > dark。 */
  function paletteFor(name: string): Palette {
    const resolved = resolve(name);
    const base = resolved === "light" ? LIGHT_PALETTE : DARK_PALETTE;
    if (name === "system") return systemColors;
    const custom = themes.get(name);
    if (custom === undefined) return base;
    return { ...base, ...custom } as Palette;
  }

  function makeTheme(name: string): Theme {
    const palette = paletteFor(name);
    return {
      name,
      color(token) {
        return palette[token] ?? DARK_PALETTE[token] ?? "#808080";
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
    theme: (name) => makeTheme(name),
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
      themes.set(name, colors);
    },
    setSystemPalette(input) {
      const signature = paletteSignature(input);
      if (signature === systemSignature) return false;
      systemSignature = signature;
      systemColors = generateOklchPalette(input);
      prefers = lightness(input.background) < 0.2 ? "dark" : "light";
      for (const listener of [...listeners]) listener();
      return true;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function lightness(hex: string): number {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  const value = Number.parseInt(match?.[1] ?? "808080", 16);
  const r = ((value >> 16) & 0xff) / 255;
  const g = ((value >> 8) & 0xff) / 255;
  const b = (value & 0xff) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
