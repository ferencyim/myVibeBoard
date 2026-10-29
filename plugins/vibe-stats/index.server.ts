import { deferStartup } from "./server/vibe/db/startup";
import { readFile } from "node:fs/promises";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  overviewRpc,
  quotaRpc,
  reindexRpc,
  statsSettings,
  type Quota,
  type UsageProvider,
} from "./shared/rpc";
import { computeOverview } from "./server/aggregate";
import { createIndexer } from "./server/indexer";
import { resolveRoots } from "./server/paths";
import { parseLiteLlmPrices, type PriceOverrides } from "./server/pricing";
import { buildSessionMap } from "./server/session-map";
import { createVibeStore, migrateOwner, openVibeDb } from "./server/vibe/db";

export default function contribute(server: PluginServerContext) {
  const db = openVibeDb();
  migrateOwner(db, "stats");
  const store = createVibeStore(db);
  const settings = server.registerSettings(statsSettings);

  let overrides: Partial<Record<UsageProvider, string[]>> = {};
  let prices: PriceOverrides = {};
  let scanSeconds = 60;
  let lastScanAt: string | null = null;
  let fileCount = 0;
  let paseo: PaseoApi | null = null;

  const applySettings = async (state: Awaited<ReturnType<typeof settings.read>>) => {
    if (state.status !== "ready") return;
    overrides = state.values.logDirs;
    scanSeconds = state.values.scanIntervalSeconds;
    prices = {};
    if (state.values.pricingFile) {
      try {
        prices = parseLiteLlmPrices(JSON.parse(await readFile(state.values.pricingFile, "utf8")));
      } catch {
        // A bad price file falls back to the built-in table.
      }
    }
  };
  const settingsReady = settings.read().then(applySettings);
  const stopSettings = settings.subscribe(applySettings);

  const indexer = createIndexer({ db, roots: () => resolveRoots(overrides), prices: () => prices });

  async function runScan() {
    await settingsReady;
    const result = await indexer.scan();
    fileCount = result.files;
    lastScanAt = new Date().toISOString();
    if (paseo) {
      try {
        indexer.relink(await buildSessionMap(paseo, store));
      } catch {
        // Daemon unreachable: events stay unlinked until the next scan.
      }
    }
    return result;
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const loop = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      runScan()
        .catch(() => undefined)
        .finally(() => !stopped && loop());
    }, scanSeconds * 1000);
    (timer as unknown as { unref?: () => void }).unref?.();
  };
  const startup = deferStartup(
    async () => {
      await runScan().catch((error) => console.error("[vibe-stats] 后台首次索引失败", error));
      loop();
    },
    (error) => console.error("[vibe-stats] 后台初始化失败", error),
  );

  const stopTurnHook = server.on("agent.turn_ended", (_event, context) => {
    paseo = context.paseo;
    void startup.ready
      .then(runScan)
      .catch((error) => console.error("[vibe-stats] 回合后索引失败", error));
  });

  server.handle(overviewRpc, async ({ period }, context) => {
    paseo = context.paseo;
    await startup.ready;
    await runScan();
    return computeOverview(db, period, new Date(), { files: fileCount, lastScanAt });
  });

  server.handle(reindexRpc, async ({ full }, context) => {
    paseo = context.paseo;
    await startup.ready;
    if (full) indexer.resetCursors();
    const { files, lines } = await runScan();
    return { files, lines };
  });

  server.handle(quotaRpc, async (_input, context): Promise<Quota> => {
    try {
      const res = await context.paseo.providers.listUsage();
      return {
        fetchedAt: res.fetchedAt,
        error: null,
        providers: res.providers.map((p) => ({
          providerId: p.providerId,
          displayName: p.displayName,
          status: p.status,
          planLabel: p.planLabel,
          windows: p.windows.map((w) => ({
            id: w.id,
            label: w.label,
            usedPct: w.usedPct ?? null,
            resetsAt: w.resetsAt ?? null,
            runsOutAt: w.runsOutAt ?? null,
            tone: w.tone ?? null,
          })),
        })),
      };
    } catch (error) {
      return {
        fetchedAt: null,
        error: error instanceof Error ? error.message : String(error),
        providers: [],
      };
    }
  });

  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    stopSettings();
    stopTurnHook();
    await startup.close();
    db.close();
  };
}
