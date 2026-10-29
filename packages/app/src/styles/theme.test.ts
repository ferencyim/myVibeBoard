import { describe, expect, it } from "vitest";
import {
  darkPureBlackTheme,
  darkTheme,
  FONT_SIZE,
  LINE_HEIGHT,
  CONTROL_HEIGHT,
  MOTION,
  BORDER_RADIUS,
  buildDarkSemanticColors,
  buildLightSemanticColors,
  getNextThemePreference,
  lightTheme,
  THEME_OPTIONS,
} from "./theme";

describe("Typography scale", () => {
  it("names 14px as the default interface tier", () => {
    expect(FONT_SIZE).toEqual({
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
    });
  });
});

describe("Theme catalog", () => {
  it("owns the picker and shortcut order", () => {
    expect(THEME_OPTIONS.map((option) => option.name)).toEqual([
      "light",
      "dark",
      "auto",
      "zinc",
      "midnight",
      "claude",
      "ghostty",
      "pureBlack",
    ]);
    expect(getNextThemePreference("dark")).toBe("auto");
    expect(getNextThemePreference("pureBlack")).toBe("light");
  });
});

describe("Pure black theme", () => {
  it("uses a pure black application and terminal background", () => {
    expect(darkPureBlackTheme.colors.surface0).toBe("#000000");
    expect(darkPureBlackTheme.colors.background).toBe("#000000");
    expect(darkPureBlackTheme.colors.terminal.background).toBe("#000000");
  });

  it("uses Paseo's muted green accent", () => {
    expect(darkPureBlackTheme.colors.accent).toBe("#20744A");
    expect(darkPureBlackTheme.colors.accentBright).toBe("#7ccba0");
  });

  it("derives sidebar interaction surfaces from the surface scale", () => {
    expect(darkPureBlackTheme.colors.surfaceSidebar).toBe("#000000");
    expect(darkPureBlackTheme.colors.surfaceSidebarHover).toBe(
      darkPureBlackTheme.colors.bgControlHover,
    );
    expect(darkPureBlackTheme.colors.surfaceSidebarSelected).toBe(
      darkPureBlackTheme.colors.bgControlActive,
    );
  });

  it("keeps ANSI black output readable on its zero-luminance terminal background", () => {
    expect(darkPureBlackTheme.colors.terminal.black).toBe("#595959");
    expect(darkPureBlackTheme.colors.terminal.brightBlack).toBe("#8a8a8a");
  });
});

describe("Sidebar interaction surfaces", () => {
  it("keeps Light hover and selection darker than the sidebar surface", () => {
    expect(lightTheme.colors.surfaceSidebarHover).toBe(lightTheme.colors.bgControlHover);
    expect(lightTheme.colors.surfaceSidebarSelected).toBe(lightTheme.colors.bgControlActive);
    expect(lightTheme.colors.surfaceSidebarSelected).not.toBe(lightTheme.colors.surfaceSidebar);
  });

  it("uses control hover and active surfaces in Dark", () => {
    expect(darkTheme.colors.surfaceSidebarHover).toBe(darkTheme.colors.bgControlHover);
    expect(darkTheme.colors.surfaceSidebarSelected).toBe(darkTheme.colors.bgControlActive);
  });
});

describe("Built-in light theme", () => {
  it("preserves its authored aliases and terminal contrast through the semantic builder", () => {
    expect(lightTheme.colors).toMatchObject({
      primary: "#1c1c1e",
      primaryForeground: "#ffffff",
      destructiveForeground: "#ffffff",
      successForeground: "#ffffff",
      terminal: {
        black: "#141414",
        brightBlack: "#3a3a3c",
      },
    });
  });
});

describe("Visual foundation", () => {
  it.each([darkTheme, lightTheme])(
    "maps legacy names to semantic roles ($colorScheme)",
    ({ colors }) => {
      expect(colors.surface0).toBe(colors.bgCanvas);
      expect(colors.surface1).toBe(colors.bgSurface);
      expect(colors.surface2).toBe(colors.bgControl);
      expect(colors.surface3).toBe(colors.bgControlHover);
      expect(colors.surface4).toBe(colors.bgControlActive);
      expect(colors.surfaceSidebar).toBe(colors.bgSidebar);
      expect(colors.surfaceWorkspace).toBe(colors.bgCanvas);
      expect(colors.popover).toBe(colors.bgSheet);
      expect(colors.foreground).toBe(colors.textPrimary);
      expect(colors.foregroundMuted).toBe(colors.textMuted);
      expect(colors.foregroundExtraMuted).toBe(colors.textDim);
      expect(colors.borderAccent).toBe(colors.borderStrong);
      expect(colors.interactionHighlight).toBe(colors.hoverTint);
      expect(colors.accentBright).toBe(colors.accentText);
      expect(colors.destructive).toBe(colors.danger);
      expect(colors.statusSuccess).toBe(colors.successText);
      expect(colors.statusDangerTint).toBe(colors.dangerSoft);
      expect(colors.statusDotRunning).toBe(colors.accent);
      expect(colors.success).not.toBe(colors.accent);
      expect(colors.ring).toBe(colors.textMuted);
    },
  );

  it("uses the authored dark and desktop light surface values on every platform", () => {
    expect(darkTheme.colors).toMatchObject({
      primary: "#f0f0f0",
      primaryForeground: "#141414",
      bgCanvas: "#1a1a1a",
      bgFrame: "#0d0d0d",
      bgSheet: "#141414",
      bgSheetInset: "#101010",
      bgControl: "#212121",
      bgControlHover: "#242424",
      bgControlActive: "#2a2a2a",
      border: "rgba(255,255,255,0.035)",
      accent: "#007cf7",
      accentText: "#42a0ff",
      textPlaceholder: "#bfbfbf",
    });
    expect(lightTheme.colors).toMatchObject({
      bgCanvas: "#f5f5f6",
      bgFrame: "#e8e8eb",
      bgSheet: "#ffffff",
      bgSheetInset: "#f0f0f2",
      bgControl: "#ffffff",
      bgControlHover: "#f0f0f2",
      bgControlActive: "#e8e8eb",
      border: "rgba(20,20,20,0.07)",
      accent: "#007cf7",
      accentText: "#0064c8",
      textPlaceholder: "#5c5c61",
    });
  });

  it("keeps custom theme surfaces, accent and foreground in new roles", () => {
    const colors = buildDarkSemanticColors({
      surface0: "#010203",
      surface1: "#112233",
      surface2: "#223344",
      surface3: "#334455",
      surface4: "#445566",
      surfaceDiffEmpty: "#111111",
      surfaceSidebar: "#020304",
      foreground: "#fefefe",
      foregroundMuted: "#aaaaaa",
      foregroundExtraMuted: "#777777",
      border: "#333333",
      borderAccent: "#444444",
      accent: "#abcdef",
      accentBright: "#bcdefa",
      destructive: "#ff1234",
      terminalBlack: "#111111",
      terminalBrightBlack: "#555555",
    });
    expect(colors.bgCanvas).toBe("#010203");
    expect(colors.bgSheet).toBe("#223344");
    expect(colors.bgControlHover).toBe("#334455");
    expect(colors.bgSidebar).toBe("#020304");
    expect(colors.textPrimary).toBe("#fefefe");
    expect(colors.accentText).toBe("#bcdefa");
    expect(colors.danger).toBe("#ff1234");
    expect(colors.primary).toBe("#fefefe");
    expect(colors.primaryForeground).toBe("#010203");
  });

  it("preserves custom light action foregrounds from its older palette contract", () => {
    const colors = buildLightSemanticColors({
      surface0: "#eff1f5",
      surface1: "#e6e9ef",
      surface2: "#dce0e8",
      surface3: "#ccd0da",
      surface4: "#9ca0b0",
      surfaceDiffEmpty: "#e6e9ef",
      surfaceSidebar: "#dce0e8",
      foreground: "#4c4f69",
      foregroundMuted: "#6c6f85",
      foregroundExtraMuted: "#9ca0b0",
      border: "#ccd0da",
      borderAccent: "#ccd0da",
      accent: "#8839ef",
      accentBright: "#8839ef",
      destructive: "#e8222d",
      primary: "#4c4f69",
      primaryForeground: "#eff1f5",
      terminalBlack: "#4c4f69",
      terminalBrightBlack: "#9ca0b0",
      ring: "#9ca0b0",
    });
    expect(colors.primary).toBe("#4c4f69");
    expect(colors.primaryForeground).toBe("#eff1f5");
    expect(colors.destructiveForeground).toBe("#eff1f5");
    expect(colors.successForeground).toBe("#eff1f5");
    expect(colors.surfaceLight).toBe("#4c4f69");
    expect(colors.textOnLight).toBe("#eff1f5");
  });

  it("owns geometry, motion and paired typography values", () => {
    expect([
      LINE_HEIGHT.sm,
      LINE_HEIGHT.md,
      LINE_HEIGHT.base,
      LINE_HEIGHT.lg,
      LINE_HEIGHT.xl,
      LINE_HEIGHT["2xl"],
      LINE_HEIGHT.display,
    ]).toEqual([16, 18, 20, 22, 24, 30, 38]);
    expect(Object.values(CONTROL_HEIGHT)).toEqual([24, 28, 32, 36, 40]);
    expect([
      BORDER_RADIUS.xs,
      BORDER_RADIUS.sm,
      BORDER_RADIUS.md,
      BORDER_RADIUS.lg,
      BORDER_RADIUS.card,
      BORDER_RADIUS.xl,
      BORDER_RADIUS.full,
    ]).toEqual([4, 6, 8, 12, 14, 20, 999]);
    expect(MOTION).toMatchObject({ fast: 120, normal: 160, slow: 200, overlay: 240 });
  });
});
