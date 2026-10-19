// Real-daemon check of the permission mode (WP-71). Skipped unless VIBE_E2E_PERMISSION=1.
//   VIBE_HOME          vibe home of the isolated daemon (scripts/vibe/dev-daemon.ps1, vibe-master installed)
//   VIBE_E2E_HOME      its paseo home            VIBE_E2E_CLI   packages/cli/dist/utils/client.js
//   VIBE_E2E_PROVIDER  provider to run the master on (default codex)
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createVibeStore, migrateOwner, openVibeDb } from "../server/vibe/db";
import { tempDir } from "./helpers";

const enabled = process.env.VIBE_E2E_PERMISSION === "1";
const provider = process.env.VIBE_E2E_PROVIDER ?? "codex";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!enabled)("permission mode against a real daemon", () => {
  it("assesses a draft in the default auto mode, then after switching the mode", async () => {
    const { connectToDaemon } = (await import(pathToFileURL(process.env.VIBE_E2E_CLI!).href)) as {
      connectToDaemon(o: unknown): Promise<{ invokePluginRpc(p: string, m: string, i: unknown): Promise<any>; close(): Promise<void> }>;
    };
    const client = await connectToDaemon({ target: { kind: "home", home: process.env.VIBE_E2E_HOME! } });
    const rpc = (method: string, input: unknown) => client.invokePluginRpc("vibe-master", method, input);

    const db = openVibeDb();
    migrateOwner(db, "core");
    const store = createVibeStore(db);
    const project =
      store.projects.list().find((p) => p.prefix === "E2E") ??
      store.projects.create({ name: "E2E", prefix: "E2E", repoPath: tempDir("vibe-e2e-repo-"), projectType: "web" });
    if (store.presets.list().length === 0) {
      store.presets.create({ name: "Codex", provider: "codex", model: "gpt-5", thinking: "high" });
      store.presets.create({ name: "Claude", provider: "claude", model: "opus" });
    }

    const switched = await rpc("master.switch", { provider, reason: "e2e" });
    console.log("master target", JSON.stringify(switched.target));
    await rpc("master.permission", { mode: "settings" }); // clean start: follow the settings default

    const evaluated = async (cardId: string, ms: number) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        if (store.events.list(cardId).some((e) => e.type === "evaluation")) return true;
        await sleep(2000);
      }
      return false;
    };

    const first = store.cards.create({ projectId: project.id, title: "Add a dark mode toggle", description: "Settings screen needs a dark mode switch." });
    const t0 = Date.now();
    expect(await evaluated(first.id, 90_000)).toBe(true);
    console.log(`first assessment after ${Math.round((Date.now() - t0) / 1000)}s`);
    const status = await rpc("master.status", { includeProviders: false });
    console.log("permission", JSON.stringify(status.permission));
    expect(status.permission).toMatchObject({ setting: "auto", auto: true });

    const options: Array<{ id: string }> = status.permission.options;
    const other = options.find((o) => o.id !== status.permission.modeId) ?? options[0]!;
    const changed = await rpc("master.permission", { mode: other.id });
    console.log("switch to", other.id, JSON.stringify(changed));
    expect(changed.changed).toBe(true);
    expect(changed.permission.modeId).toBe(other.id);

    const second = store.cards.create({ projectId: project.id, title: "Add CSV export", description: "Export the card list as CSV." });
    const t1 = Date.now();
    expect(await evaluated(second.id, 150_000)).toBe(true);
    console.log(`second assessment after ${Math.round((Date.now() - t1) / 1000)}s`);

    await rpc("master.permission", { mode: "settings" });
    await client.close();
    db.close();
  }, 400_000);
});
