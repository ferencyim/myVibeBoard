import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { resolveDaemonVersion } from "../daemon-version.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("a plugin gets its Paseo API at start-up and can push through the daemon", async () => {
  const pluginDirectory = await mkdtemp(path.join(tmpdir(), "paseo-notify-plugin-"));
  roots.push(pluginDirectory);
  await writeFile(
    path.join(pluginDirectory, "paseo-plugin.json"),
    JSON.stringify({
      id: "notify",
      requirements: { paseo: `>=${resolveDaemonVersion(import.meta.url)}` },
    }),
  );
  await writeFile(
    path.join(pluginDirectory, "index.server.ts"),
    `export default function contribute(server) {
  // No hook or RPC has run yet: the handle must already work.
  void server.paseo.agents.list({ page: { limit: 1 } }).then((result) => {
    server.notify({ title: "Project", body: "agents:" + result.entries.length, data: { cardKey: "VB-1" } });
  });
  return () => undefined;
}`,
  );

  const send = vi.fn(async () => undefined);
  const daemon = await createTestPaseoDaemon({ pushNotificationSender: { send } });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.4.0",
  });
  try {
    await client.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(pluginDirectory);
    await vi.waitFor(() => expect(send).toHaveBeenCalled(), { timeout: 10_000 });
    expect(send).toHaveBeenCalledWith({
      title: "Project",
      body: "agents:0",
      data: { cardKey: "VB-1" },
    });
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
  }
}, 60_000);
