/** Update the host snapshot before reading dependent plugin catalogs. */
export async function refreshModelCatalog(
  refreshSnapshot: () => Promise<void>,
  refreshCatalog?: () => Promise<unknown>,
): Promise<void> {
  await refreshSnapshot();
  await refreshCatalog?.();
}
