import { expect, it } from "vitest";
import { isPluginModelCatalogQuery } from "./model-catalog-queries";

it("refreshes each plugin model catalog without invalidating unrelated plugin data", () => {
  expect(isPluginModelCatalogQuery(["vibe-bots", "models", "project-a"])).toBe(true);
  expect(isPluginModelCatalogQuery(["vibe-bots", "create-models", "project-a"])).toBe(true);
  expect(isPluginModelCatalogQuery(["vibe-board", "task-defaults-models", "host-a"])).toBe(true);
  expect(isPluginModelCatalogQuery(["vibe-board", "presets", "host-a"])).toBe(false);
  expect(isPluginModelCatalogQuery(["vibe-bots", "bots", "project-a"])).toBe(false);
});
