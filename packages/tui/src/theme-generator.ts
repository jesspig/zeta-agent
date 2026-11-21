/**
 * T-05 主题增强的纯函数层：OKLCH 颜色工具、从终端调色板派生 system 主题、
 * 明暗检测与主题文件 100ms 防抖热重载。
 *
 * 所有颜色输出为 #RRGGBB 字符串，不依赖 OpenTUI 的色值格式（规避 OQ-04）。
 */

/** 扩展后的语义 token（前 8 个为既有基础 token，其余为高保真 UI 语义色）。 */
export const SEMANTIC_TOKENS = [
  "accent", "text", "border", "muted", "error", "info", "warning", "thinking",
  "background", "surface", "surfaceAlt", "overlay", "selectionBg", "selectionFg", "userMessageBg", "userMessageText",
  "success", "danger", "link", "code", "codeBg", "heading", "subtext", "faint",
  "diffAdded", "diffRemoved", "diffAddedBg", "diffRemovedBg", "diffContext",
  "toolPending", "toolSuccess", "toolError", "toolBorder", "toolBg",
  "gitBranch", "gitClean", "gitDirty", "gitAhead", "gitBehind",
  "statusIdle", "statusWorking", "statusStreaming", "statusTool", "statusError",
  "footerText", "footerMuted", "footerWarn", "footerCritical",
  "spinner", "progress", "progressBg", "cursor", "caret",
  "focusBorder", "hoverBg", "activeBg", "disabled", "placeholder",
  "notification", "notificationInfo", "notificationWarn", "notificationError",
  "chart1", "chart2", "chart3", "chart4",
] as const;

export interface TerminalPaletteInput {
  readonly foreground: string;
  readonly background: string;
  readonly ansi: readonly string[];
}

export type GeneratedPalette = Record<(typeof SEMANTIC_TOKENS)[number], string>;

type Rgb = readonly [number, number, number];

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function hexToRgb(hex: string): Rgb {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!match) return [128, 128, 128];
  const value = Number.parseInt(match[1] ?? "808080", 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function rgbToHex(rgb: Rgb): string {
  const toHex = (channel: number) => clamp(Math.round(channel), 0, 255).toString(16).padStart(2, "0");
  return `#${toHex(rgb[0])}${toHex(rgb[1])}${toHex(rgb[2])}`;
}

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(channel: number): number {
  const c = channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
  return clamp(c) * 255;
}

/** 感知亮度（WCAG 近似），用于明暗检测；返回 0..1。 */
export function lightnessOf(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** sRGB → OKLab（Björn Ottosson 公式）。 */
function rgbToOklab(rgb: Rgb): Rgb {
  const r = srgbToLinear(rgb[0]);
  const g = srgbToLinear(rgb[1]);
  const b = srgbToLinear(rgb[2]);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLab → sRGB。 */
function oklabToRgb(lab: Rgb): Rgb {
  const l = lab[0] + 0.3963377774 * lab[1] + 0.2158037573 * lab[2];
  const m = lab[0] - 0.1055613458 * lab[1] - 0.0638541728 * lab[2];
  const s = lab[0] - 0.0894841775 * lab[1] - 1.291485548 * lab[2];
  const l3 = l * l * l;
  const m3 = m * m * m;
  const s3 = s * s * s;
  return [
    linearToSrgb(4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3),
    linearToSrgb(-1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3),
    linearToSrgb(-0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3),
  ];
}

function oklchToRgb(l: number, c: number, hDeg: number): Rgb {
  const h = (hDeg * Math.PI) / 180;
  return oklabToRgb([l, c * Math.cos(h), c * Math.sin(h)]);
}

/** OKLCH 调色板：由终端前景/背景与 ANSI 色相派生 60+ 语义色。 */
export function generateOklchPalette(input: TerminalPaletteInput): GeneratedPalette {
  const bg = hexToRgb(input.background);
  const fg = hexToRgb(input.foreground);
  const isDark = lightnessOf(input.background) < 0.2;
  const ansi = input.ansi.length >= 8 ? input.ansi : [
    "#000000", "#ff5555", "#55ff55", "#ffff55", "#5555ff", "#ff55ff", "#55ffff", "#aaaaaa",
  ];
  const red = hexToRgb(ansi[1] ?? "#ff5555");
  const green = hexToRgb(ansi[2] ?? "#55ff55");
  const yellow = hexToRgb(ansi[3] ?? "#ffff55");
  const blue = hexToRgb(ansi[4] ?? "#5555ff");
  const magenta = hexToRgb(ansi[5] ?? "#ff55ff");
  const cyan = hexToRgb(ansi[6] ?? "#55ffff");

  const lab = rgbToOklab(fg);
  const baseL = lab[0];
  const baseC = Math.sqrt(lab[1] * lab[1] + lab[2] * lab[2]);
  const baseH = (Math.atan2(lab[2], lab[1]) * 180) / Math.PI;
  const l = (delta: number) => clamp(baseL + delta * (isDark ? 1 : -1), 0.05, 0.97);
  const tone = (color: Rgb, delta = 0) => {
    const c = rgbToOklab(color);
    const chroma = Math.sqrt(c[1] * c[1] + c[2] * c[2]);
    const hue = (Math.atan2(c[2], c[1]) * 180) / Math.PI;
    return rgbToHex(oklchToRgb(l(delta), chroma, hue));
  };
  const accent = rgbToHex(oklchToRgb(l(0), Math.max(baseC, 0.08), baseH));
  const surface = rgbToHex(mix(bg, fg, isDark ? 0.06 : 0.04));
  const surfaceAlt = rgbToHex(mix(bg, fg, isDark ? 0.11 : 0.08));

  return {
    accent,
    text: rgbToHex(fg),
    border: rgbToHex(mix(bg, fg, isDark ? 0.22 : 0.3)),
    muted: tone(fg, -0.12),
    error: tone(red),
    info: tone(blue),
    warning: tone(yellow),
    thinking: tone(magenta),
    background: rgbToHex(bg),
    surface,
    surfaceAlt,
    overlay: rgbToHex(mix(bg, fg, isDark ? 0.16 : 0.12)),
    selectionBg: rgbToHex(mix(bg, blue, isDark ? 0.35 : 0.25)),
    selectionFg: rgbToHex(fg),
    userMessageBg: rgbToHex(mix(bg, blue, isDark ? 0.3 : 0.16)),
    userMessageText: rgbToHex(fg),
    success: tone(green),
    danger: tone(red),
    link: tone(cyan),
    code: tone(green, -0.04),
    codeBg: surfaceAlt,
    heading: tone(fg, 0.08),
    subtext: tone(fg, -0.08),
    faint: tone(fg, -0.2),
    diffAdded: tone(green, -0.05),
    diffRemoved: tone(red, -0.05),
    diffAddedBg: rgbToHex(mix(bg, green, isDark ? 0.14 : 0.1)),
    diffRemovedBg: rgbToHex(mix(bg, red, isDark ? 0.14 : 0.1)),
    diffContext: tone(fg, -0.16),
    toolPending: tone(blue),
    toolSuccess: tone(green),
    toolError: tone(red),
    toolBorder: rgbToHex(mix(bg, fg, 0.28)),
    toolBg: surface,
    gitBranch: tone(magenta),
    gitClean: tone(green),
    gitDirty: tone(yellow),
    gitAhead: tone(cyan),
    gitBehind: tone(yellow),
    statusIdle: tone(fg, -0.14),
    statusWorking: tone(blue),
    statusStreaming: tone(cyan),
    statusTool: tone(yellow),
    statusError: tone(red),
    footerText: tone(fg, -0.04),
    footerMuted: tone(fg, -0.18),
    footerWarn: tone(yellow),
    footerCritical: tone(red),
    spinner: tone(cyan),
    progress: tone(green),
    progressBg: rgbToHex(mix(bg, fg, 0.14)),
    cursor: tone(fg),
    caret: accent,
    focusBorder: tone(blue),
    hoverBg: rgbToHex(mix(bg, fg, isDark ? 0.1 : 0.07)),
    activeBg: rgbToHex(mix(bg, fg, isDark ? 0.16 : 0.12)),
    disabled: tone(fg, -0.3),
    placeholder: tone(fg, -0.24),
    notification: tone(fg, -0.06),
    notificationInfo: tone(blue),
    notificationWarn: tone(yellow),
    notificationError: tone(red),
    chart1: tone(blue),
    chart2: tone(green),
    chart3: tone(yellow),
    chart4: tone(magenta),
  };
}

/** 构建 system 主题：检测明暗 + 派生完整语义调色板。 */
export function buildSystemPalette(input: TerminalPaletteInput): {
  readonly mode: "dark" | "light";
  readonly colors: GeneratedPalette;
} {
  return {
    mode: lightnessOf(input.background) < 0.2 ? "dark" : "light",
    colors: generateOklchPalette(input),
  };
}

export interface ThemeReloader {
  readonly delayMs: number;
  notify(): void;
  dispose(): void;
}

/** 主题文件变更的 100ms 防抖热重载：连续 notify 合并为一次触发。 */
export function createDebouncedThemeReloader(onReload: () => void, delayMs = 100): ThemeReloader {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    delayMs,
    notify() {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        onReload();
      }, delayMs);
    },
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
