import { Platform } from "react-native";
import { darkHighlightColors, lightHighlightColors } from "@getpaseo/highlight";

export const baseColors = {
  // Base colors
  white: "#ffffff",
  black: "#000000",

  // Zinc scale (primary gray palette)
  zinc: {
    50: "#fafafa",
    100: "#f4f4f5",
    200: "#e4e4e7",
    300: "#d4d4d8",
    400: "#a1a1aa",
    500: "#71717a",
    600: "#52525b",
    700: "#3f3f46",
    800: "#27272a",
    850: "#1a1a1d",
    900: "#18181b",
    950: "#121214",
  },

  // Gray scale
  gray: {
    50: "#f9fafb",
    100: "#f3f4f6",
    200: "#e5e7eb",
    300: "#d1d5db",
    400: "#9ca3af",
    500: "#6b7280",
    600: "#4b5563",
    700: "#374151",
    800: "#1f2937",
    900: "#111827",
  },

  // Slate scale
  slate: {
    200: "#e2e8f0",
  },

  // Blue scale
  blue: {
    50: "#eff6ff",
    100: "#dbeafe",
    200: "#bfdbfe",
    300: "#93c5fd",
    400: "#60a5fa",
    500: "#3b82f6",
    600: "#2563eb",
    700: "#1d4ed8",
    800: "#1e40af",
    900: "#1e3a8a",
    950: "#172554",
  },

  // Green scale
  green: {
    100: "#dcfce7",
    200: "#bbf7d0",
    400: "#4ade80",
    500: "#22c55e",
    600: "#16a34a",
    800: "#166534",
    900: "#14532d",
  },

  // Red scale
  red: {
    100: "#fee2e2",
    200: "#fecaca",
    300: "#fca5a5",
    500: "#ef4444",
    600: "#dc2626",
    800: "#991b1b",
    900: "#7f1d1d",
  },

  // Teal scale
  teal: {
    200: "#99f6e4",
  },

  // Amber scale
  amber: {
    500: "#f59e0b",
    700: "#b45309",
  },

  // Yellow scale
  yellow: {
    400: "#fbbf24",
  },

  // Purple scale
  purple: {
    500: "#a855f7",
    600: "#9333ea",
  },

  // Orange scale
  orange: {
    500: "#f97316",
    600: "#ea580c",
  },
} as const;

// Diff colors — the +/- inside a diff view, where the color *is* the signal and has to
// survive being scanned line by line, so it stays saturated. Light uses muted tones, dark
// uses the brighter palette values.
//
// A diff *stat* — the "+12 −3" footnote next to a title — is not this. It is a status
// signal, so it uses statusSuccess/statusDanger below rather than a tier of its own.
const lightDiffColors = {
  diffAddition: "#15803d", // green-700 — readable on white without screaming
  diffDeletion: "#b91c1c", // red-700
};

const darkDiffColors = {
  diffAddition: "#4ade80", // green-400
  diffDeletion: "#ef4444", // red-500
};

// Values describe our own RN surfaces; no external component implementation is used.
const darkFoundationColors = {
  bgCanvas: "#1a1a1a",
  bgFrame: "#0d0d0d",
  bgSidebar: "#1a1a1a",
  bgSheet: "#141414",
  bgSheetInset: "#101010",
  bgGrouped: "#212121",
  groupedTextMuted: "#96969b",
  groupedBorder: "#333335",
  bgSurface: "#212121",
  bgSurfaceRaised: "#242424",
  bgControl: "#212121",
  bgControlHover: "#242424",
  bgControlActive: "#2a2a2a",
  tabsBar: "#212121",
  tabsPill: "#2a2a2a",
  border: "rgba(255,255,255,0.035)",
  borderStrong: "rgba(255,255,255,0.045)",
  hoverTint: "rgba(255,255,255,0.06)",
  textPrimary: "#ffffff",
  textSecondary: "#dcdcdc",
  textMuted: "#979797",
  textDim: "#6a6a6a",
  textPlaceholder: "#bfbfbf",
  textReadable: "rgba(255,255,255,0.52)",
  settingsTextMuted: "rgba(255,255,255,0.59)",
  surfaceLight: "#f0f0f0",
  textOnLight: "#141414",
  accent: "#007cf7",
  accentHover: "#1f8fff",
  accentText: "#42a0ff",
  accentSoft: "rgba(0,124,247,0.16)",
  accentSoftStrong: "rgba(0,124,247,0.34)",
  success: "#31cf76",
  successText: "#31cf76",
  successSoft: "rgba(49,207,118,0.12)",
  warning: "#ff9412",
  warningText: "#ff9412",
  warningSoft: "rgba(255,148,18,0.12)",
  danger: "#fd2f3b",
  dangerText: "#ff6069",
  dangerHover: "#fd5d67",
  dangerSoft: "rgba(253,47,59,0.16)",
  dangerSoftHover: "rgba(253,47,59,0.28)",
  questionOption: "#6bc7d9",
  badgeNew: "#ff1e5e",
  unreadBg: "#74b9ff",
  unreadText: "#07131f",
  bgOverlay: "rgba(26,26,26,0.92)",
  dialogOverlay: "rgba(0,0,0,0.10)",
  dialogRing: "rgba(255,255,255,0.10)",
  bgGlass: "rgba(33,33,33,0.76)",
};

const lightFoundationColors: typeof darkFoundationColors = {
  bgCanvas: "#f5f5f6",
  bgFrame: "#e8e8eb",
  bgSidebar: "#f5f5f6",
  bgSheet: "#ffffff",
  bgSheetInset: "#f0f0f2",
  bgGrouped: "#ffffff",
  groupedTextMuted: "#6b6b70",
  groupedBorder: "#e3e3e6",
  bgSurface: "#ffffff",
  bgSurfaceRaised: "#fcfcfc",
  bgControl: "#ffffff",
  bgControlHover: "#f0f0f2",
  bgControlActive: "#e8e8eb",
  tabsBar: "#ececee",
  tabsPill: "#ffffff",
  border: "rgba(20,20,20,0.07)",
  borderStrong: "rgba(20,20,20,0.10)",
  hoverTint: "rgba(20,20,20,0.05)",
  textPrimary: "#141414",
  textSecondary: "#3a3a3c",
  textMuted: "#6b6b70",
  textDim: "#8e8e93",
  textPlaceholder: "#5c5c61",
  textReadable: "rgba(20,20,20,0.60)",
  settingsTextMuted: "rgba(20,20,20,0.60)",
  surfaceLight: "#1c1c1e",
  textOnLight: "#ffffff",
  accent: "#007cf7",
  accentHover: "#006ad4",
  accentText: "#0064c8",
  accentSoft: "rgba(0,124,247,0.12)",
  accentSoftStrong: "rgba(0,124,247,0.26)",
  success: "#1fa85a",
  successText: "#187a41",
  successSoft: "rgba(31,168,90,0.12)",
  warning: "#f08a00",
  warningText: "#9c5200",
  warningSoft: "rgba(240,138,0,0.14)",
  danger: "#e8222d",
  dangerText: "#c0141d",
  dangerHover: "#f04a53",
  dangerSoft: "rgba(232,34,45,0.12)",
  dangerSoftHover: "rgba(232,34,45,0.20)",
  questionOption: "#16849b",
  badgeNew: "#e0004a",
  unreadBg: "#74b9ff",
  unreadText: "#07131f",
  bgOverlay: "rgba(245,245,246,0.92)",
  dialogOverlay: "rgba(20,20,20,0.12)",
  dialogRing: "rgba(20,20,20,0.10)",
  bgGlass: "rgba(255,255,255,0.76)",
};

function foundationAliases(colors: typeof darkFoundationColors) {
  return {
    surface0: colors.bgCanvas,
    surface1: colors.bgSurface,
    surface2: colors.bgControl,
    surface3: colors.bgControlHover,
    surface4: colors.bgControlActive,
    surfaceSidebar: colors.bgSidebar,
    surfaceSidebarHover: colors.bgControlHover,
    surfaceSidebarSelected: colors.bgControlActive,
    surfaceWorkspace: colors.bgCanvas,
    interactionHighlight: colors.hoverTint,
    foreground: colors.textPrimary,
    foregroundMuted: colors.textMuted,
    foregroundExtraMuted: colors.textDim,
    borderAccent: colors.borderStrong,
    accentBright: colors.accentText,
    destructive: colors.danger,
    destructiveForeground: "#ffffff",
    successForeground: "#ffffff",
    background: colors.bgCanvas,
    popover: colors.bgSheet,
    popoverForeground: colors.textPrimary,
    secondary: colors.bgControl,
    secondaryForeground: colors.textPrimary,
    muted: colors.bgGrouped,
    mutedForeground: colors.textMuted,
    accentBorder: colors.borderStrong,
    input: colors.bgControl,
    statusSuccess: colors.successText,
    statusDanger: colors.dangerText,
    statusWarning: colors.warningText,
    statusMerged: "#a890d5",
    statusSuccessTint: colors.successSoft,
    statusDangerTint: colors.dangerSoft,
    statusWarningTint: colors.warningSoft,
    statusDotSuccess: colors.success,
    statusDotDanger: colors.danger,
    statusDotWarning: colors.warning,
    statusDotRunning: colors.accent,
  };
}

// Plugin themes still supply the older surface contract. Derive new roles from those
// authored values so choosing a plugin preserves its surfaces and foregrounds.
function foundationForTint(
  tint: DarkThemeConfig | LightThemeConfig,
  defaults: typeof darkFoundationColors,
) {
  return {
    ...defaults,
    bgCanvas: tint.surface0,
    bgFrame: tint.surfaceSidebar,
    bgSidebar: tint.surfaceSidebar,
    bgSheet: tint.surface2,
    bgSheetInset: tint.surface0,
    bgGrouped: tint.surface1,
    groupedTextMuted: tint.foregroundMuted,
    groupedBorder: tint.border,
    bgSurface: tint.surface1,
    bgSurfaceRaised: tint.surface2,
    bgControl: tint.surface2,
    bgControlHover: tint.surface3,
    bgControlActive: tint.surface4,
    tabsBar: tint.surface2,
    tabsPill: tint.surface4,
    border: tint.border,
    borderStrong: tint.borderAccent,
    textPrimary: tint.foreground ?? defaults.textPrimary,
    textSecondary: tint.foregroundMuted,
    textMuted: tint.foregroundMuted,
    textDim: tint.foregroundExtraMuted,
    textPlaceholder: tint.foregroundMuted,
    surfaceLight: tint.foreground ?? defaults.surfaceLight,
    textOnLight: tint.surface0,
    accent: tint.accent,
    accentHover: tint.accentBright,
    accentText: tint.accentBright,
    danger: tint.destructive,
    ...tint.foundation,
  };
}

export interface LightThemeConfig {
  foundation?: Partial<typeof darkFoundationColors>;
  surface0: string;
  surface1: string;
  surface2: string;
  surface3: string;
  surface4: string;
  surfaceDiffEmpty: string;
  surfaceSidebar: string;
  foreground: string;
  foregroundMuted: string;
  foregroundExtraMuted: string;
  border: string;
  borderAccent: string;
  accent: string;
  accentBright: string;
  accentForeground?: string;
  primary: string;
  primaryForeground: string;
  destructive: string;
  terminalBlack: string;
  terminalBrightBlack: string;
  ring: string;
}

const lightTerminalAnsi = {
  red: "#dc2626",
  green: "#16a34a",
  yellow: "#ca8a04",
  blue: "#2563eb",
  magenta: "#9333ea",
  cyan: "#0891b2",
  white: "#ffffff",
  brightRed: "#ef4444",
  brightGreen: "#22c55e",
  brightYellow: "#f59e0b",
  brightBlue: "#3b82f6",
  brightMagenta: "#a855f7",
  brightCyan: "#06b6d4",
  brightWhite: "#fafafa",
} as const;

export function buildLightSemanticColors(tint: LightThemeConfig) {
  const colors = foundationForTint(tint, lightFoundationColors);
  return {
    ...colors,
    ...foundationAliases(colors),
    surfaceDiffEmpty: tint.surfaceDiffEmpty,
    accentForeground: tint.accentForeground ?? tint.surface0,
    destructiveForeground: colors.textOnLight,
    successForeground: colors.textOnLight,
    primary: tint.primary,
    primaryForeground: tint.primaryForeground,
    ring: tint.ring,
    ...lightDiffColors,
    terminal: {
      background: tint.surface0,
      foreground: tint.foreground,
      cursor: tint.foreground,
      cursorAccent: tint.surface0,
      selectionBackground: "rgba(0, 0, 0, 0.15)",
      selectionForeground: tint.foreground,
      black: tint.terminalBlack,
      ...lightTerminalAnsi,
      brightBlack: tint.terminalBrightBlack,
    },
  };
}

const lightSemanticColors = buildLightSemanticColors({
  foundation: lightFoundationColors,
  surface0: lightFoundationColors.bgCanvas,
  surface1: lightFoundationColors.bgSurface,
  surface2: lightFoundationColors.bgControl,
  surface3: lightFoundationColors.bgControlHover,
  surface4: lightFoundationColors.bgControlActive,
  surfaceDiffEmpty: lightFoundationColors.bgSheetInset,
  surfaceSidebar: lightFoundationColors.bgSidebar,
  foreground: lightFoundationColors.textPrimary,
  foregroundMuted: lightFoundationColors.textMuted,
  foregroundExtraMuted: lightFoundationColors.textDim,
  border: lightFoundationColors.border,
  borderAccent: lightFoundationColors.borderStrong,
  accent: lightFoundationColors.accent,
  accentBright: lightFoundationColors.accentText,
  accentForeground: "#ffffff",
  primary: lightFoundationColors.surfaceLight,
  primaryForeground: lightFoundationColors.textOnLight,
  destructive: lightFoundationColors.danger,
  terminalBlack: "#141414",
  terminalBrightBlack: "#3a3a3c",
  ring: lightFoundationColors.textMuted,
});

// ---------------------------------------------------------------------------
// Dark theme variant builder
// ---------------------------------------------------------------------------

export interface DarkThemeConfig {
  foundation?: Partial<typeof darkFoundationColors>;
  surface0: string;
  surface1: string;
  surface2: string;
  surface3: string;
  surface4: string;
  surfaceDiffEmpty: string;
  surfaceSidebar: string;
  foregroundMuted: string;
  foregroundExtraMuted: string;
  border: string;
  borderAccent: string;
  accent: string;
  accentBright: string;
  accentForeground?: string;
  destructive: string;
  terminalBlack: string;
  terminalBrightBlack: string;
  foreground?: string;
  ring?: string;
}

const darkTerminalAnsi = {
  red: "#e07070",
  green: "#5dba80",
  yellow: "#d4a44a",
  blue: "#6a9de0",
  magenta: "#b07ad0",
  cyan: "#4aabb8",
  white: "#d4d4d8",
  brightRed: "#e89090",
  brightGreen: "#7ecf9a",
  brightYellow: "#e0be6e",
  brightBlue: "#8ab4e8",
  brightMagenta: "#c49ae0",
  brightCyan: "#6ec2cc",
  brightWhite: "#f0f0f2",
} as const;

export function buildDarkSemanticColors(tint: DarkThemeConfig) {
  const colors = foundationForTint(tint, darkFoundationColors);
  const foreground = colors.textPrimary;
  const ring = tint.ring ?? colors.textMuted;
  return {
    ...colors,
    ...foundationAliases(colors),
    surfaceDiffEmpty: tint.surfaceDiffEmpty,
    accentForeground: tint.accentForeground ?? "#ffffff",
    primary: colors.surfaceLight,
    primaryForeground: colors.textOnLight,
    ring,
    ...darkDiffColors,
    terminal: {
      background: tint.surface0,
      foreground,
      cursor: foreground,
      cursorAccent: tint.surface0,
      selectionBackground: "rgba(255, 255, 255, 0.2)",
      selectionForeground: foreground,
      black: tint.terminalBlack,
      ...darkTerminalAnsi,
      brightBlack: tint.terminalBrightBlack,
    },
  };
}

// ---------------------------------------------------------------------------
// Dark tint definitions
// ---------------------------------------------------------------------------

const paseoDarkColors = buildDarkSemanticColors({
  foundation: darkFoundationColors,
  surface0: darkFoundationColors.bgCanvas,
  surface1: darkFoundationColors.bgSurface,
  surface2: darkFoundationColors.bgControl,
  surface3: darkFoundationColors.bgControlHover,
  surface4: darkFoundationColors.bgControlActive,
  surfaceDiffEmpty: darkFoundationColors.bgSheetInset,
  surfaceSidebar: darkFoundationColors.bgSidebar,
  foreground: darkFoundationColors.textPrimary,
  foregroundMuted: darkFoundationColors.textMuted,
  foregroundExtraMuted: darkFoundationColors.textDim,
  border: darkFoundationColors.border,
  borderAccent: darkFoundationColors.borderStrong,
  accent: darkFoundationColors.accent,
  accentBright: darkFoundationColors.accentText,
  destructive: darkFoundationColors.danger,
  terminalBlack: "#101010",
  terminalBrightBlack: "#6a6a6a",
});

// Zinc — neutral gray, no tint
const zincDarkColors = buildDarkSemanticColors({
  surface0: "#18181b",
  surface1: "#1f1f22",
  surface2: "#27272a",
  surface3: "#3f3f46",
  surface4: "#52525b",
  surfaceDiffEmpty: "#242427",
  surfaceSidebar: "#131316",
  foregroundMuted: "#a1a1aa",
  foregroundExtraMuted: "#71717a",
  border: "#27272a",
  borderAccent: "#303036",
  accent: "#e4e4e7",
  accentBright: "#fafafa",
  accentForeground: "#18181b", // monochrome zinc accent is near-white — needs dark text
  destructive: "#c44a4a", // neutral red, hue 0 — clearly red without screaming
  terminalBlack: "#131316",
  terminalBrightBlack: "#3f3f46",
});

// Midnight — subtle blue tint
const midnightDarkColors = buildDarkSemanticColors({
  surface0: "#161820",
  surface1: "#1c1e27",
  surface2: "#252731",
  surface3: "#3c3e4c",
  surface4: "#535564",
  surfaceDiffEmpty: "#222430",
  surfaceSidebar: "#121420",
  foregroundMuted: "#9a9db0",
  foregroundExtraMuted: "#6b6e82",
  border: "#242636",
  borderAccent: "#2e3040",
  accent: "#3b6fcf",
  accentBright: "#7eaaeb",
  destructive: "#c44a52", // red with a hint of cool lean against the blue tint
  terminalBlack: "#121420",
  terminalBrightBlack: "#3c3e4c",
});

// Claude — warm neutral with subtle orange undertone
const claudeDarkColors = buildDarkSemanticColors({
  surface0: "#1f1f1e",
  surface1: "#262523",
  surface2: "#2f2d2b",
  surface3: "#4a4745",
  surface4: "#605d5b",
  surfaceDiffEmpty: "#2a2826",
  surfaceSidebar: "#1a1918",
  foregroundMuted: "#ada9a5",
  foregroundExtraMuted: "#78746f",
  border: "#2c2a27",
  borderAccent: "#36332f",
  accent: "#d97757",
  accentBright: "#e89a7f",
  destructive: "#cf513e", // warm orange-red, hue ~10 — sits with the Claude orange accent
  terminalBlack: "#1a1918",
  terminalBrightBlack: "#4a4745",
});

// Ghostty — blue-tinted dark based on Ghostty default background
const ghosttyDarkColors = buildDarkSemanticColors({
  surface0: "#282c34",
  surface1: "#2f333d",
  surface2: "#383c48",
  surface3: "#4a4f5e",
  surface4: "#5b6175",
  surfaceDiffEmpty: "#323643",
  surfaceSidebar: "#21252d",
  foregroundMuted: "#c8ccd8",
  foregroundExtraMuted: "#a0a4b2",
  border: "#353a47",
  borderAccent: "#3f4454",
  accent: "#89b4fa",
  accentBright: "#b4d0fc",
  destructive: "#c44a55", // red with slight cool lean against the slate-blue surfaces
  terminalBlack: "#21252d",
  terminalBrightBlack: "#4a4f5e",
});

export const SPACING = {
  0: 0,
  0.5: 2,
  1: 4,
  1.5: 6,
  2: 8,
  3: 12,
  4: 16,
  6: 24,
  8: 32,
  12: 48,
  16: 64,
  20: 80,
  24: 96,
  32: 128,
} as const;

export const FONT_SIZE = {
  code: 12,
  content: 16,
  sm: 12,
  md: 13,
  base: 14,
  lg: 16,
  xl: 18,
  "2xl": 24,
  "3xl": 24,
  "4xl": 32,
  display: 32,
} as const;

export const LINE_HEIGHT = {
  sm: 16,
  md: 18,
  base: 20,
  lg: 22,
  xl: 24,
  "2xl": 30,
  "3xl": 30,
  "4xl": 38,
  display: 38,
  code: 16,
  content: 22,
  diff: 22,
} as const;

export const ICON_SIZE = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 20,
} as const;

export const ICON_STROKE_WIDTH = 1.5;

export const FONT_WEIGHT = {
  normal: "400" as const,
  medium: "500" as const,
  semibold: "600" as const,
  bold: "700" as const,
} as const;

export const BORDER_RADIUS = {
  none: 0,
  xs: 4,
  sm: 6,
  base: 4,
  md: 8,
  lg: 12,
  card: 14,
  xl: 20,
  "2xl": 20,
  full: 999,
} as const;

export const CONTROL_HEIGHT = { xs: 24, sm: 28, md: 32, lg: 36, xl: 40 } as const;

export const MOTION = {
  fast: 120,
  normal: 160,
  slow: 200,
  overlay: 240,
  easeOut: "cubic-bezier(.23,1,.32,1)",
  easeInOut: "cubic-bezier(.77,0,.175,1)",
} as const;

export const BORDER_WIDTH = {
  0: 0,
  1: 1,
  2: 2,
} as const;

export const OPACITY = {
  0: 0,
  disabled: 0.45,
  50: 0.5,
  100: 1,
} as const;

// Platform default font stacks — copied verbatim from constants/theme.ts `Fonts`
// (sans -> ui, mono -> mono). These seed the dynamic `fontFamily` theme token and
// are the fallback an empty user-supplied family resolves to at apply time.
export const DEFAULT_UI_FONT_STACK: string = Platform.select({
  ios: "system-ui",
  default: "normal",
  web: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
});

export const DEFAULT_MONO_FONT_STACK: string = Platform.select({
  ios: "ui-monospace",
  default: "monospace",
  web: "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
});

// Chat and markdown content column; the appearance updater patches the user's width in.
export const DEFAULT_CONTENT_MAX_WIDTH = 820;

// `fontSize`, `fontFamily`, `lineHeight`, and `contentMaxWidth` are deliberately widened to plain
// `number`/`string` (not narrowed by `as const`) so the appearance updater can patch
// them at runtime via `UnistylesRuntime.updateTheme`. The remaining tokens keep their
// literal types.
interface CommonTheme {
  spacing: typeof SPACING;
  fontSize: Record<keyof typeof FONT_SIZE, number>;
  fontFamily: { ui: string; mono: string };
  lineHeight: Record<keyof typeof LINE_HEIGHT, number>;
  contentMaxWidth: number;
  iconSize: typeof ICON_SIZE;
  fontWeight: typeof FONT_WEIGHT;
  borderRadius: typeof BORDER_RADIUS;
  borderWidth: typeof BORDER_WIDTH;
  opacity: typeof OPACITY;
  controlHeight: typeof CONTROL_HEIGHT;
  motion: typeof MOTION;
}

const commonTheme: CommonTheme = {
  spacing: SPACING,
  fontSize: FONT_SIZE,
  fontFamily: { ui: DEFAULT_UI_FONT_STACK, mono: DEFAULT_MONO_FONT_STACK },
  lineHeight: LINE_HEIGHT,
  contentMaxWidth: DEFAULT_CONTENT_MAX_WIDTH,
  iconSize: ICON_SIZE,
  fontWeight: FONT_WEIGHT,
  borderRadius: BORDER_RADIUS,
  borderWidth: BORDER_WIDTH,
  opacity: OPACITY,
  controlHeight: CONTROL_HEIGHT,
  motion: MOTION,
};

const darkShadow = {
  sm: {
    shadowColor: "rgba(0, 0, 0, 0.25)",
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 4,
    elevation: 2,
  },
  md: {
    shadowColor: "rgba(0, 0, 0, 0.20)",
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 8,
    elevation: 8,
  },
  lg: {
    shadowColor: "rgba(0, 0, 0, 0.40)",
    shadowOffset: { width: 0, height: 12 },
    shadowRadius: 24,
    elevation: 8,
  },
} as const;

export function buildDarkTheme(semanticColors: ReturnType<typeof buildDarkSemanticColors>) {
  return {
    colorScheme: "dark" as const,
    colors: {
      ...semanticColors,
      palette: baseColors,
      syntax: darkHighlightColors,
    },
    shadow: darkShadow,
    ...commonTheme,
  } as const;
}

export const darkTheme = buildDarkTheme(paseoDarkColors);
export const darkZincTheme = buildDarkTheme(zincDarkColors);
export const darkMidnightTheme = buildDarkTheme(midnightDarkColors);
export const darkClaudeTheme = buildDarkTheme(claudeDarkColors);
export const darkGhosttyTheme = buildDarkTheme(ghosttyDarkColors);

// Pure black — zero-luminance background with high-contrast surfaces.
const pureBlackDarkColors = buildDarkSemanticColors({
  surface0: "#000000",
  surface1: "#0a0a0a",
  surface2: "#111111",
  surface3: "#202020",
  surface4: "#2d2d2d",
  surfaceDiffEmpty: "#0c0c0c",
  surfaceSidebar: "#000000",
  foregroundMuted: "#a1a1aa",
  foregroundExtraMuted: "#71717a",
  border: "#1c1c1c",
  borderAccent: "#242424",
  accent: "#20744A",
  accentBright: "#7ccba0",
  destructive: "#c44a4a",
  terminalBlack: "#595959",
  terminalBrightBlack: "#8a8a8a",
});

export const darkPureBlackTheme = buildDarkTheme(pureBlackDarkColors);

const lightShadow = {
  sm: {
    shadowColor: "rgba(0, 0, 0, 0.08)",
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 8,
    elevation: 2,
  },
  md: {
    shadowColor: "rgba(0, 0, 0, 0.04)",
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 16,
    elevation: 4,
  },
  lg: {
    shadowColor: "rgba(0, 0, 0, 0.08)",
    shadowOffset: { width: 0, height: 8 },
    shadowRadius: 24,
    elevation: 8,
  },
} as const;

export function buildLightTheme(semanticColors: ReturnType<typeof buildLightSemanticColors>) {
  return {
    colorScheme: "light" as const,
    colors: {
      ...semanticColors,
      palette: baseColors,
      syntax: lightHighlightColors,
    },
    shadow: lightShadow,
    ...commonTheme,
  } as const;
}

export const lightTheme = buildLightTheme(lightSemanticColors);

// Keep compatibility with existing code
export const theme = darkTheme;

export const THEME_OPTIONS = [
  {
    name: "light",
    group: "primary",
    unistylesName: "light",
    theme: lightTheme,
    swatch: "#ffffff",
  },
  {
    name: "dark",
    group: "primary",
    unistylesName: "dark",
    theme: darkTheme,
    swatch: "#007cf7",
  },
  { name: "auto", group: "primary" },
  {
    name: "zinc",
    group: "variant",
    unistylesName: "darkZinc",
    theme: darkZincTheme,
    swatch: "#808080",
  },
  {
    name: "midnight",
    group: "variant",
    unistylesName: "darkMidnight",
    theme: darkMidnightTheme,
    swatch: "#4A6BA8",
  },
  {
    name: "claude",
    group: "variant",
    unistylesName: "darkClaude",
    theme: darkClaudeTheme,
    swatch: "#D97757",
  },
  {
    name: "ghostty",
    group: "variant",
    unistylesName: "darkGhostty",
    theme: darkGhosttyTheme,
    swatch: "#8caaee",
  },
  {
    name: "pureBlack",
    group: "variant",
    unistylesName: "darkPureBlack",
    theme: darkPureBlackTheme,
    swatch: "#000000",
  },
] as const;

export const PLUGIN_THEME_PREFERENCE = "plugin";
export const PLUGIN_THEME_NAMES = {
  light: "pluginLight",
  dark: "pluginDark",
} as const;

export type ThemePreference =
  | (typeof THEME_OPTIONS)[number]["name"]
  | typeof PLUGIN_THEME_PREFERENCE;
export type ThemeName = Exclude<ThemePreference, "auto" | typeof PLUGIN_THEME_PREFERENCE>;
type ConcreteThemeOption = Exclude<(typeof THEME_OPTIONS)[number], { name: "auto" }>;
export type Theme = ConcreteThemeOption["theme"];

const CONCRETE_THEME_OPTIONS = THEME_OPTIONS.filter(
  (option): option is ConcreteThemeOption => option.name !== "auto",
);

type ThemeToUnistyles = {
  [Name in ThemeName]: Extract<ConcreteThemeOption, { name: Name }>["unistylesName"];
};

type ThemeSwatches = {
  [Name in ThemeName]: Extract<ConcreteThemeOption, { name: Name }>["swatch"];
};

type RegisteredThemes = {
  [Option in ConcreteThemeOption as Option["unistylesName"]]: Option["theme"];
} & {
  pluginLight: typeof lightTheme;
  pluginDark: typeof darkTheme;
};

export const THEME_TO_UNISTYLES = Object.fromEntries(
  CONCRETE_THEME_OPTIONS.map((option) => [option.name, option.unistylesName]),
) as ThemeToUnistyles;

export const THEME_SWATCHES = Object.fromEntries(
  CONCRETE_THEME_OPTIONS.map((option) => [option.name, option.swatch]),
) as ThemeSwatches;

export const REGISTERED_THEMES = {
  ...Object.fromEntries(
    CONCRETE_THEME_OPTIONS.map((option) => [option.unistylesName, option.theme]),
  ),
  [PLUGIN_THEME_NAMES.light]: lightTheme,
  [PLUGIN_THEME_NAMES.dark]: darkTheme,
} as RegisteredThemes;

export function getNextThemePreference(current: ThemePreference): ThemePreference {
  const currentIndex = THEME_OPTIONS.findIndex((option) => option.name === current);
  const nextIndex = (currentIndex + 1) % THEME_OPTIONS.length;
  return THEME_OPTIONS[nextIndex]?.name ?? THEME_OPTIONS[0].name;
}
