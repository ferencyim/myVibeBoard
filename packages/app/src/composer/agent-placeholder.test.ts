import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import { resolveAgentPlaceholder, resolveAgentTarget } from "./agent-placeholder";

const t = ((key: string, options?: { name?: string }) =>
  `${key}:${options?.name ?? ""}`) as unknown as TFunction;

describe("resolveAgentTarget", () => {
  it("prefers the bot name", () => {
    expect(resolveAgentTarget({ botName: "小助", labels: { "vibe.tab.role": "main" } })).toBe(
      "小助",
    );
  });
  it("maps task tab roles to numbered names", () => {
    expect(resolveAgentTarget({ labels: { "vibe.tab.role": "main" } })).toBe("#1 主会话");
    expect(resolveAgentTarget({ labels: { "vibe.tab.role": "verifier" } })).toBe("#6 验证");
  });
  it("treats tab-order 1 without a role as the main session of an older task", () => {
    expect(resolveAgentTarget({ labels: { "paseo.tab-order": "1" } })).toBe("#1 主会话");
    expect(resolveAgentTarget({ labels: { "paseo.tab-order": "2" } })).toBeNull();
  });
  it("returns null for ordinary sessions and unknown roles", () => {
    expect(resolveAgentTarget({ labels: {} })).toBeNull();
    expect(resolveAgentTarget({ labels: { "vibe.tab.role": "session" } })).toBeNull();
  });
});

describe("resolveAgentPlaceholder", () => {
  it("keeps the default for ordinary sessions", () => {
    expect(resolveAgentPlaceholder(t, { labels: null, isDesktop: true })).toBeUndefined();
  });
  it("names the target on desktop and mobile", () => {
    expect(resolveAgentPlaceholder(t, { botName: "小助", isDesktop: true })).toBe(
      "composer.placeholders.toTarget:小助",
    );
    expect(
      resolveAgentPlaceholder(t, { labels: { "vibe.tab.role": "main" }, isDesktop: false }),
    ).toBe("composer.placeholders.toTargetMobile:#1 主会话");
  });
});
