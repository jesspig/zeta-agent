import { generateOklchPalette, SEMANTIC_TOKENS, type GeneratedPalette, type TerminalPaletteInput } from "./theme-generator";

export type ThemeName = "system" | "dark" | "light";
export type ColorToken = (typeof SEMANTIC_TOKENS)[number];

const REQUIRED_TOKENS: readonly ColorToken[] = SEMANTIC_TOKENS;

type Palette = Readonly<GeneratedPalette>;

const DARK_BASE: Partial<Palette> = {
  // 目标终端 UI（dark）精确取色：okhsl 转 #RRGGBB
  accent: "#a798d7",
  text: "#dee0e1",
  border: "#5fa8cc",
  borderMuted: "#768186",
  borderAccent: "#a08ed5",
  muted: "#9da5a9",
  dim: "#7e888e",
  error: "#ea7f81",
  info: "#69add0",
  warning: "#cd9a22",
  success: "#68b78d",
  thinking: "#a798d7",
  thinkingText: "#96a0a4",
  selectedBg: "#213b49",
  userMessageBg: "#213b49",
  userMessageText: "#dee0e1",
  toolPendingBg: "#34383a",
  toolSuccessBg: "#254131",
  toolErrorBg: "#5b282a",
  toolTitle: "#dee0e1",
  toolOutput: "#9da5a9",
  mdHeading: "#cd9a22",
  mdLink: "#69add0",
  mdLinkUrl: "#9da5a9",
  mdCode: "#a798d7",
  mdCodeBlock: "#68b78d",
  mdCodeBlockBorder: "#9da5a9",
  mdListBullet: "#a798d7",
  quoteText: "#9da5a9",
  quoteBorder: "#9da5a9",
  mdRule: "#9da5a9",
  toolDiffAdded: "#68b78d",
  toolDiffRemoved: "#ea7f81",
  toolDiffContext: "#9da5a9",
  syntaxKeyword: "#69add0",
  syntaxString: "#de8d5a",
  syntaxNumber: "#68b78d",
  syntaxType: "#a798d7",
  syntaxFunction: "#cd9a22",
};

const LIGHT_BASE: Partial<Palette> = {
  accent: "#7459b4",
  text: "#3b3f41",
  border: "#3d8eb3",
  borderMuted: "#9aa2a7",
  borderAccent: "#8a72cb",
  muted: "#677176",
  dim: "#879095",
  error: "#c8253d",
  info: "#2f7899",
  warning: "#8f6802",
  success: "#337e58",
  thinking: "#7459b4",
  thinkingText: "#7c868c",
  selectedBg: "#dfe7ec",
  userMessageBg: "#dfe7ec",
  userMessageText: "#3b3f41",
  toolPendingBg: "#e4e5e6",
  toolSuccessBg: "#dee9e1",
  toolErrorBg: "#eee2e1",
  toolTitle: "#3b3f41",
  toolOutput: "#677176",
  mdHeading: "#8f6802",
  mdLink: "#2f7899",
  mdLinkUrl: "#677176",
  mdCode: "#7459b4",
  mdCodeBlock: "#337e58",
  mdCodeBlockBorder: "#677176",
  mdListBullet: "#7459b4",
  quoteText: "#677176",
  quoteBorder: "#677176",
  mdRule: "#677176",
  toolDiffAdded: "#337e58",
  toolDiffRemoved: "#c8253d",
  toolDiffContext: "#677176",
  syntaxKeyword: "#2f7899",
  syntaxString: "#a45417",
  syntaxNumber: "#337e58",
  syntaxType: "#7459b4",
  syntaxFunction: "#8f6802",
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
