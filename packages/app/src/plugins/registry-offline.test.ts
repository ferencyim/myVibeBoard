import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { expect, test, vi } from "vitest";
import { createPluginHosts } from "./hosts";
import { PluginRegistry } from "./registry";

const audio = { play: async () => 0 };

function fakeClient(rpc = vi.fn(async () => "online")) {
  return {
    observeEvents: () => ({
      ready: Promise.resolve({ subscriptionId: "x" }),
      subscribe: () => () => undefined,
      release: async () => undefined,
    }),
    invokePluginRpc: rpc,
  } as unknown as DaemonClient;
}

function registry(options: { live?: () => DaemonClient | null } = {}) {
  const invokeOffline = vi.fn(async () => "offline");
  const plugins = new PluginRegistry({
    version: "0.8.0",
    getLiveClient: options.live,
    invokeOffline,
    createRuntime: (installation) => ({
      hosts: createPluginHosts(
        {
          getHosts: () => [],
          getSnapshot: () => null,
          subscribeAll: () => () => {},
          subscribeHostList: () => () => {},
        },
        installation.lifetime.signal,
      ),
      paseo: installation.paseo,
      rpc: async () => {
        throw new Error("Unexpected plugin RPC");
      },
      openScreen: () => {},
      openSurface: () => {},
      openSettings: () => {},
      playAudio: async () => {},
      openPanel: () => {},
      setTaskConversationRecipients: () => {},
      addComposerPill: () => ({ update() {}, remove() {} }),
      addHeaderButton: () => ({ update() {}, remove() {} }),
    }),
  });
  return { plugins, invokeOffline };
}

const entry = (id: string, marker = "a") => ({
  id,
  requirements: { paseo: ">=0.8.0" },
  clientBundle: `(function() { return { default: function(plugin) { /* ${marker} */ return function() {}; } }; })`,
});

test("an installation restored from the cache answers RPCs locally and has no Paseo API", async () => {
  const { plugins, invokeOffline } = registry({ live: () => null });
  plugins.restoreFromCache("host", [entry("board")], { audio });

  const [board] = plugins.getSnapshot();
  expect(board?.id).toBe("board");
  await expect(board?.invoke("vibe.cards.list", { a: 1 })).resolves.toBe("offline");
  expect(invokeOffline).toHaveBeenCalledWith("host", "board", "vibe.cards.list", { a: 1 });
  expect(() => board?.paseo.agents.list()).toThrow("[offline]");
  await expect(board?.paseo.dispose()).resolves.toBeUndefined();
});

test("the same installation switches between daemon and local RPC with the connection", async () => {
  let live: DaemonClient | null = null;
  const rpc = vi.fn(async () => "online");
  const client = fakeClient(rpc);
  const { plugins, invokeOffline } = registry({ live: () => live });
  plugins.installCatalog("host", [entry("board")], { client, audio });
  const [board] = plugins.getSnapshot();

  live = client;
  await expect(board?.invoke("m", 1)).resolves.toBe("online");
  expect(rpc).toHaveBeenCalledWith("board", "m", 1);
  live = null;
  await expect(board?.invoke("m", 2)).resolves.toBe("offline");
  expect(invokeOffline).toHaveBeenCalledTimes(1);
});

test("going online replaces the cached installation but keeps it across disconnects", () => {
  const { plugins } = registry({ live: () => null });
  const client = fakeClient();
  plugins.restoreFromCache("host", [entry("board")], { audio });
  const [cached] = plugins.getSnapshot();

  // A second restore (reconnect flap while offline) changes nothing.
  plugins.restoreFromCache("host", [entry("board")], { audio });
  expect(plugins.getSnapshot()[0]).toBe(cached);

  plugins.installCatalog("host", [entry("board")], { client, audio });
  const [online] = plugins.getSnapshot();
  expect(online).not.toBe(cached);

  // The online installation survives a refresh with the same client and bundle.
  plugins.installCatalog("host", [entry("board")], { client, audio });
  expect(plugins.getSnapshot()[0]).toBe(online);
});

test("pruneHosts drops only hosts that left the app", () => {
  const { plugins } = registry();
  plugins.restoreFromCache("kept", [entry("board")], { audio });
  plugins.restoreFromCache("gone", [entry("board")], { audio });
  plugins.pruneHosts(["kept"]);
  expect(plugins.getSnapshot().map((p) => p.serverId)).toEqual(["kept"]);
});
