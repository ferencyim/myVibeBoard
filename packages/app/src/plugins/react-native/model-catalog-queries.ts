/** Plugin catalog RPCs use these keys; other plugin state must not reload on model refresh. */
export function isPluginModelCatalogQuery(queryKey: readonly unknown[]): boolean {
  return queryKey.some(
    (part) =>
      typeof part === "string" && /^(models|create-models|task-defaults-models)$/.test(part),
  );
}
