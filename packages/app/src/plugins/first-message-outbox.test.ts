import { describe, expect, it } from "vitest";
import { resolveFirstMessageOutboxOwner } from "./first-message-outbox";

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
