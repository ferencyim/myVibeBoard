// GENERATED FROM plugins/vibe-shared — DO NOT EDIT (run: node scripts/vibe/sync-shared.mjs)
// Readable model names for tab titles. Providers may address models by opaque ids (`dfmodel`);
// the catalog label (`DeepSeek-Flash`) is what users recognize, with the id as the fallback.

export interface ModelCatalogSource {
  providers: {
    listModels(
      provider: string,
    ): Promise<{ models?: ReadonlyArray<{ id: string; label?: string }> } | undefined>;
  };
}

const labels = new Map<string, string>();

export async function providerModelLabel(
  catalog: ModelCatalogSource,
  provider: string,
  model: string,
  timeoutMs = 5_000,
): Promise<string> {
  if (!model) return model;
  const key = provider + "/" + model;
  const cached = labels.get(key);
  if (cached) return cached;
  // Keep filling the cache after a timeout: the first catalog query can be a cold provider
  // discovery, and later calls must be able to show the label without waiting again.
  const listing = catalog.providers.listModels(provider).then(
    (listed) => {
      for (const item of listed?.models ?? [])
        if (item?.id) labels.set(provider + "/" + item.id, item.label?.trim() || item.id);
      return labels.get(key);
    },
    () => undefined,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const resolved = await Promise.race([
      listing,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
    return resolved ?? labels.get(key) ?? model;
  } finally {
    clearTimeout(timer);
  }
}
