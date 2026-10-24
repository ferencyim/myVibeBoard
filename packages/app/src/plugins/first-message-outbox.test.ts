import { describe, expect, it } from "vitest";
import {
  resolveFirstMessageOutboxOwner,
  resolveFirstMessageSubmissionOwner,
  saveFirstMessageOutboxOwner,
} from "./first-message-outbox";

const owner = {
  id: "custom-task-owner",
  serverId: "host",
  firstMessageOutboxOwners: [{ initialRole: "planner" }],
};

describe("first-message outbox owner", () => {
  it("uses the runtime installation ID and only the selected host's declarations", () => {
    expect(resolveFirstMessageOutboxOwner([owner], "host")).toEqual({
      pluginId: "custom-task-owner",
      initialRole: "planner",
    });
    expect(resolveFirstMessageOutboxOwner([owner], "other-host")).toBeUndefined();
  });
  it("falls back to ordinary agents after the plugin is disabled or removed", () => {
    expect(resolveFirstMessageOutboxOwner([], "host")).toBeUndefined();
    expect(
      resolveFirstMessageOutboxOwner([{ ...owner, firstMessageOutboxOwners: [] }], "host"),
    ).toBeUndefined();
  });
  it("rejects conflicting owners instead of silently selecting a plugin", () => {
    expect(() =>
      resolveFirstMessageOutboxOwner([owner, { ...owner, id: "other-owner" }], "host"),
    ).toThrow("多个插件");
  });
});

describe("first-message submission routing", () => {
  const input = {
    serverId: "host",
    plugins: [owner],
    connected: true,
    catalogLoaded: true,
    pluginsSupported: true,
  };
  it("keeps the draft when the online plugin catalog has not finished loading", async () => {
    await expect(
      resolveFirstMessageSubmissionOwner({ ...input, plugins: [], catalogLoaded: false }),
    ).rejects.toThrow("插件尚未加载完成");
  });
  it("reports a catalog request failure while preserving the draft", async () => {
    await expect(
      resolveFirstMessageSubmissionOwner({
        ...input,
        plugins: [],
        catalogLoaded: false,
        catalogError: "task-owner",
      }),
    ).rejects.toThrow("插件加载失败：task-owner");
  });
  it.each(["startup failed", "client evaluation failed"])(
    "allows ordinary and task creation when an unrelated plugin has %s",
    async (error) => {
      const getPluginError = (pluginId: string) =>
        pluginId === "unrelated-plugin" ? error : undefined;
      await expect(
        resolveFirstMessageSubmissionOwner({ ...input, plugins: [], getPluginError }),
      ).resolves.toBeUndefined();
      await expect(
        resolveFirstMessageSubmissionOwner({ ...input, getPluginError }),
      ).resolves.toEqual({ pluginId: owner.id, initialRole: "planner" });
    },
  );
  it("blocks only the live first-message owner when it is unavailable", async () => {
    await expect(
      resolveFirstMessageSubmissionOwner({
        ...input,
        getPluginError: (pluginId) => (pluginId === owner.id ? "startup failed" : undefined),
      }),
    ).rejects.toThrow(`首消息负责插件 ${owner.id} 不可用`);
  });
  it.each(["startup failed", "client evaluation failed"])(
    "retains the saved owner after its %s and blocks its submission",
    async (error) => {
      const serverId = `failed-owner-${error}`;
      const plugins = [{ ...owner, serverId }];
      const getPluginError = (pluginId: string) => (pluginId === owner.id ? error : undefined);
      await saveFirstMessageOutboxOwner(serverId, plugins);
      await saveFirstMessageOutboxOwner(serverId, [], getPluginError);
      await expect(
        resolveFirstMessageSubmissionOwner({
          ...input,
          serverId,
          plugins: [],
          getPluginError,
        }),
      ).rejects.toThrow(`首消息负责插件 ${owner.id} 不可用`);
      await expect(
        resolveFirstMessageSubmissionOwner({
          ...input,
          serverId,
          plugins: [],
          connected: false,
          getPluginError,
        }),
      ).resolves.toEqual({ pluginId: owner.id, initialRole: "planner" });
      // An explicit disable/removal has no error and restores ordinary creation.
      await saveFirstMessageOutboxOwner(serverId, [], () => undefined);
      await expect(
        resolveFirstMessageSubmissionOwner({ ...input, serverId, plugins: [] }),
      ).resolves.toBeUndefined();
    },
  );
  it("allows ordinary sessions only after a loaded catalog has no owner", async () => {
    await expect(
      resolveFirstMessageSubmissionOwner({ ...input, plugins: [] }),
    ).resolves.toBeUndefined();
    await expect(resolveFirstMessageSubmissionOwner(input)).resolves.toEqual({
      pluginId: owner.id,
      initialRole: "planner",
    });
  });
  it("restores only the host's routing metadata offline without evaluating a plugin bundle", async () => {
    await saveFirstMessageOutboxOwner("host", [owner]);
    await expect(
      resolveFirstMessageSubmissionOwner({
        ...input,
        plugins: [],
        connected: false,
        catalogLoaded: false,
      }),
    ).resolves.toEqual({ pluginId: owner.id, initialRole: "planner" });
    await expect(
      resolveFirstMessageSubmissionOwner({ ...input, serverId: "unknown-host", connected: false }),
    ).rejects.toThrow("请先联网一次");
  });
  it("persists disabling the owner so later offline starts use ordinary sessions", async () => {
    await saveFirstMessageOutboxOwner("disabled-host", []);
    await expect(
      resolveFirstMessageSubmissionOwner({ ...input, serverId: "disabled-host", connected: false }),
    ).resolves.toBeUndefined();
  });
});
