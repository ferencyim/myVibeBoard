import { describe, expect, it, vi } from "vitest";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { fetchPreview, latestSidebarMessage, sidebarAgentActivity } from "./sidebar-agent-activity";

const agent = (overrides: Partial<AggregatedAgent> = {}) =>
  ({
    id: "bot-agent",
    serverId: "host-a",
    turn: { phase: "idle", cancellationRequestId: null },
    pendingPermissionCount: 0,
    requiresAttention: false,
    attentionReason: null,
    ...overrides,
  }) as AggregatedAgent;

describe("bot sidebar activity", () => {
  it("prioritizes failures and approvals over running", () => {
    const running = {
      phase: "open",
      turnId: null,
      startedAt: null,
      cancellationRequestId: null,
    } as const;
    expect(sidebarAgentActivity(agent({ turn: running, attentionReason: "error" })).status).toBe(
      "failed",
    );
    expect(sidebarAgentActivity(agent({ turn: running, pendingPermissionCount: 1 })).status).toBe(
      "waiting",
    );
    expect(sidebarAgentActivity(agent({ turn: running })).status).toBe("working");
  });
  it("takes the newest cached message text and its own timestamp", () => {
    expect(
      latestSidebarMessage([
        {
          kind: "assistant_message",
          id: "new",
          text: "latest",
          timestamp: new Date("2026-01-02T00:00:00Z"),
        },
        {
          kind: "user_message",
          id: "old",
          text: "old",
          timestamp: new Date("2026-01-01T00:00:00Z"),
        },
      ]),
    ).toEqual({ text: "latest", timestamp: "2026-01-02T00:00:00.000Z" });
    expect(latestSidebarMessage([])).toBeUndefined();
  });
  it("loads an older page when the tail contains only tools", async () => {
    const fetchAgentTimeline = vi
      .fn()
      .mockResolvedValueOnce({
        error: null,
        entries: [],
        hasOlder: true,
        startCursor: { epoch: "e", seq: 4 },
      })
      .mockResolvedValueOnce({
        error: null,
        entries: [
          { item: { type: "assistant_message", text: "reply" }, timestamp: "2026-01-02T00:00:00Z" },
        ],
        hasOlder: false,
      });
    const client = {
      fetchAgentTimeline,
    } as unknown as import("@getpaseo/client/internal/daemon-client").DaemonClient;
    await expect(fetchPreview(client, "agent")).resolves.toEqual({
      text: "reply",
      timestamp: "2026-01-02T00:00:00Z",
    });
    expect(fetchAgentTimeline).toHaveBeenCalledTimes(2);
    expect(fetchAgentTimeline.mock.calls[1]?.[1]).toMatchObject({
      direction: "before",
      cursor: { epoch: "e", seq: 4 },
    });
  });
  it("shows a reply only when attention is outstanding", () => {
    expect(
      sidebarAgentActivity(agent({ requiresAttention: true, attentionReason: "finished" })).status,
    ).toBe("responded");
    expect(
      sidebarAgentActivity(agent({ requiresAttention: false, attentionReason: "finished" })).status,
    ).toBeUndefined();
  });
});
