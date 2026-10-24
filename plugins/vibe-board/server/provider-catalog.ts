import type { PaseoApi } from "@getpaseo/client";

// The settings RPC has a 30-second host deadline. Slow provider initialization must
// leave time to return the models already available from other providers.
export const PROVIDER_CATALOG_TIMEOUT_MS = 5_000;
async function catalogDeadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("模型目录查询超时")),
          PROVIDER_CATALOG_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function providerCatalog(paseo: PaseoApi) {
  try {
    const available = await catalogDeadline(paseo.providers.listAvailable());
    const providers = await Promise.all(
      available.providers.map(async (p) => {
        let models: Array<{
          id: string;
          name: string;
          thinkingOptions?: Array<{ id: string; label: string }>;
          defaultThinkingOptionId?: string;
        }> = [];
        if (p.available) {
          try {
            const res = await catalogDeadline(paseo.providers.listModels(p.provider));
            models = (res.models ?? []).map((m) => ({
              id: m.id,
              name: m.label || m.id,
              thinkingOptions: m.thinkingOptions?.map((o) => ({
                id: o.id,
                label: o.label || o.id,
              })),
              defaultThinkingOptionId:
                m.defaultThinkingOptionId ?? m.thinkingOptions?.find((o) => o.isDefault)?.id,
            }));
          } catch {
            // model listing is best effort
          }
        }
        return { id: p.provider, available: p.available, models };
      }),
    );
    return { providers };
  } catch {
    return { providers: [] };
  }
}
