import { describe, expect, it } from "vitest";
import { isRetiredVibePush, resolveVibePushRoute } from "./push-route";

describe("resolveVibePushRoute", () => {
  it("opens the exact host, workspace and agent named in the push", () => {
    expect(
      resolveVibePushRoute({
        event: "session.waiting",
        serverId: "named",
        workspaceId: "workspace",
        agentId: "agent",
      }),
    ).toBe("/h/named/workspace/workspace?open=agent%3Aagent");
  });

  it("opens a workspace when the push has no agent", () => {
    expect(resolveVibePushRoute({ serverId: "named", workspaceId: "workspace" })).toBe(
      "/h/named/workspace/workspace",
    );
  });

  it("never guesses a host or workspace", () => {
    for (const data of [
      undefined,
      { agentId: "agent" },
      { serverId: "named", agentId: "agent" },
      { workspaceId: "workspace", agentId: "agent" },
      { event: "session.waiting", cardKey: "VB-7" },
    ]) {
      expect(resolveVibePushRoute(data)).toBeNull();
    }
  });

  it("keeps retired card pushes out of native tasks", () => {
    const data = {
      event: "card.verifying",
      cardKey: "VB-7",
      serverId: "named",
      workspaceId: "workspace",
      agentId: "agent",
    };
    expect(isRetiredVibePush(data)).toBe(true);
    expect(resolveVibePushRoute(data)).toBeNull();
    expect(isRetiredVibePush({ event: "session.waiting" })).toBe(false);
  });

  it("retires old session notifications carrying a card identity", () => {
    for (const data of [
      { event: "session.waiting", cardKey: "VB-7", agentId: "old-agent" },
      { event: "session.error", cardId: "old-card", agentId: "old-agent" },
    ]) {
      expect(isRetiredVibePush(data)).toBe(true);
      expect(resolveVibePushRoute(data)).toBeNull();
    }
  });
});
