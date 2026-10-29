import { lightHighlightColors } from "@getpaseo/highlight";

const testTheme = {
  colorScheme: "light",
  colors: {
    bgCanvas: "#f5f5f6",
    bgFrame: "#e8e8eb",
    bgSidebar: "#f5f5f6",
    bgSheet: "#ffffff",
    bgSheetInset: "#f0f0f2",
    bgGrouped: "#ffffff",
    bgSurface: "#ffffff",
    bgSurfaceRaised: "#fcfcfc",
    bgControl: "#ffffff",
    bgControlHover: "#f0f0f2",
    bgControlActive: "#e8e8eb",
    hoverTint: "rgba(20,20,20,.05)",
    borderStrong: "rgba(20,20,20,.10)",
    textPrimary: "#141414",
    textSecondary: "#3a3a3c",
    textMuted: "#6b6b70",
    textDim: "#8e8e93",
    textPlaceholder: "#5c5c61",
    accentHover: "#006ad4",
    accentText: "#0064c8",
    accentSoft: "rgba(0,124,247,.12)",
    accentSoftStrong: "rgba(0,124,247,.26)",
    successText: "#187a41",
    successSoft: "rgba(31,168,90,.12)",
    warning: "#f08a00",
    warningText: "#9c5200",
    warningSoft: "rgba(240,138,0,.14)",
    danger: "#e8222d",
    dangerHover: "#f04a53",
    dangerText: "#c0141d",
    dangerSoft: "rgba(232,34,45,.12)",
    dangerSoftHover: "rgba(232,34,45,.20)",
    unreadBg: "#74b9ff",
    unreadText: "#07131f",
    bgOverlay: "rgba(245,245,246,.92)",
    dialogOverlay: "rgba(20,20,20,.12)",
    dialogRing: "rgba(20,20,20,.10)",
    primary: "#1c1c1e",
    primaryForeground: "#ffffff",
    syntax: lightHighlightColors,
    foreground: "#111111",
    foregroundMuted: "#666666",
    statusSuccess: "#15803d",
    statusDanger: "#b91c1c",
    statusWarning: "#d97706",
    statusMerged: "#7c3aed",
    // Same rule as the real theme: the status color at 12%.
    statusSuccessTint: "#15803d1f",
    statusDangerTint: "#b91c1c1f",
    statusWarningTint: "#d977061f",
    // The light band's values, so a test can name the colour it expects.
    statusDotSuccess: "#299f51",
    statusDotDanger: "#f12e2f",
    statusDotWarning: "#b37824",
    statusDotRunning: "#268ae0",
    accent: "#2563eb",
    accentForeground: "#ffffff",
    destructive: "#dc2626",
    destructiveForeground: "#ffffff",
    surface1: "#fafafa",
    surface2: "#f4f4f5",
    surface3: "#e4e4e7",
    border: "#e4e4e7",
    borderAccent: "#a1a1aa",
    palette: {
      amber: { 500: "#f59e0b" },
      blue: { 300: "#93c5fd" },
      green: { 500: "#22c55e" },
      red: { 300: "#fca5a5" },
      white: "#ffffff",
    },
  },
  borderWidth: { 1: 1 },
  spacing: { 0: 0, 0.5: 2, 1: 4, 1.5: 6, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 7: 28, 8: 32 },
  fontSize: {
    xs: 12,
    sm: 12,
    md: 13,
    base: 14,
    lg: 16,
    xl: 18,
    "2xl": 24,
    "3xl": 24,
    "4xl": 32,
    display: 32,
  },
  lineHeight: {
    sm: 16,
    md: 18,
    base: 20,
    lg: 22,
    xl: 24,
    "2xl": 30,
    "3xl": 30,
    "4xl": 38,
    display: 38,
    content: 22,
    code: 16,
    diff: 22,
  },
  controlHeight: { xs: 24, sm: 28, md: 32, lg: 36, xl: 40 },
  motion: {
    fast: 120,
    normal: 160,
    slow: 200,
    overlay: 240,
    easeOut: "cubic-bezier(.23,1,.32,1)",
    easeInOut: "cubic-bezier(.77,0,.175,1)",
  },
  fontFamily: {
    ui: "sans-serif",
    mono: "monospace",
  },
  fontWeight: {
    normal: "400",
    medium: "500",
    semibold: "600",
    bold: "700",
  },
  borderRadius: {
    xs: 4,
    sm: 6,
    base: 4,
    md: 8,
    lg: 12,
    card: 14,
    xl: 20,
    "2xl": 20,
    full: 999,
  },
  iconSize: { sm: 16, md: 20 },
  opacity: { 50: 0.5 },
  shadow: {
    sm: {
      shadowColor: "rgba(0, 0, 0, 0.02)",
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
  },
};

type StyleFactory<T> = (theme: typeof testTheme) => T;

function isStyleFactory<T>(styles: T | StyleFactory<T>): styles is StyleFactory<T> {
  return typeof styles === "function";
}

export const StyleSheet = {
  create: <T>(styles: T | StyleFactory<T>): T =>
    isStyleFactory(styles) ? styles(testTheme) : styles,
};

export const withUnistyles = <T>(Component: T): T => Component;

export const useUnistyles = () => ({
  theme: testTheme,
  rt: {},
  breakpoint: undefined,
});

export const UnistylesRuntime = {
  setTheme: () => undefined,
  themeName: "light",
};
