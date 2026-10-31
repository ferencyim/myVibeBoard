import { expect, it, vi } from "vitest";
import { refreshModelCatalog } from "./refresh-model-catalog";

it("refreshes the host snapshot before reloading the plugin catalog", async () => {
  const order: string[] = [];
  const snapshot = vi.fn(async () => {
    order.push("snapshot");
  });
  const catalog = vi.fn(async () => {
    order.push("catalog");
  });
  await refreshModelCatalog(snapshot, catalog);
  expect(order).toEqual(["snapshot", "catalog"]);
  expect(snapshot).toHaveBeenCalledTimes(1);
  expect(catalog).toHaveBeenCalledTimes(1);
});

it("propagates host errors and does not reload a stale catalog", async () => {
  const catalog = vi.fn();
  await expect(
    refreshModelCatalog(async () => {
      throw new Error("offline");
    }, catalog),
  ).rejects.toThrow("offline");
  expect(catalog).not.toHaveBeenCalled();
});
