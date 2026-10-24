import type { PaseoApi } from "@getpaseo/client";
import { afterEach, expect, it, vi } from "vitest";
import { providerCatalog, PROVIDER_CATALOG_TIMEOUT_MS } from "../server/provider-catalog";

afterEach(() => vi.useRealTimers());
it("a stuck provider cannot hide available Codex models or failed provider entries", async () => {
  vi.useFakeTimers();
  const listModels = vi.fn((provider: string) => {
    if (provider === "copilot") return new Promise<never>(() => {});
    if (provider === "claude") return Promise.reject(new Error("provider unavailable"));
    return Promise.resolve({
      models: [
        {
          id: "cheap",
          label: "Codex cheap",
          thinkingOptions: [{ id: "low", label: "低", isDefault: true }],
        },
      ],
    });
  });
  const paseo = {
    providers: {
      listAvailable: async () => ({
        providers: [
          { provider: "codex", available: true },
          { provider: "copilot", available: true },
          { provider: "claude", available: true },
          { provider: "pi", available: false },
        ],
      }),
      listModels,
    },
  } as unknown as PaseoApi;
  const response = providerCatalog(paseo);
  await vi.advanceTimersByTimeAsync(PROVIDER_CATALOG_TIMEOUT_MS);
  expect(await response).toEqual({
    providers: [
      {
        id: "codex",
        available: true,
        models: [
          {
            id: "cheap",
            name: "Codex cheap",
            thinkingOptions: [{ id: "low", label: "低" }],
            defaultThinkingOptionId: "low",
          },
        ],
      },
      { id: "copilot", available: true, models: [] },
      { id: "claude", available: true, models: [] },
      { id: "pi", available: false, models: [] },
    ],
  });
  expect(listModels.mock.calls.map(([provider]) => provider)).toEqual([
    "codex",
    "copilot",
    "claude",
  ]);
  expect(vi.getTimerCount()).toBe(0);
});
it("also bounds a stuck availability query", async () => {
  vi.useFakeTimers();
  const paseo = {
    providers: { listAvailable: () => new Promise<never>(() => {}) },
  } as unknown as PaseoApi;
  const response = providerCatalog(paseo);
  await vi.advanceTimersByTimeAsync(PROVIDER_CATALOG_TIMEOUT_MS);
  expect(await response).toEqual({ providers: [] });
  expect(vi.getTimerCount()).toBe(0);
});
