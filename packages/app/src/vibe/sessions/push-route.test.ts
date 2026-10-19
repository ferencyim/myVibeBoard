import { describe, expect, it } from "vitest";
import { resolveVibePushRoute } from "./push-route";

describe("resolveVibePushRoute", () => {
  it("opens the card on the board for a verifying push", () => {
    expect(resolveVibePushRoute({ event: "card.verifying", cardKey: "VB-7" }, ["srv"])).toBe(
      "/h/srv/plugin/vibe-board/surface/board?param.card=VB-7",
    );
  });

  it("opens the session overview for a waiting push", () => {
    expect(resolveVibePushRoute({ event: "session.waiting", cardKey: "VB-7" }, ["srv"])).toBe(
      "/h/srv/plugin/vibe-board/surface/sessions",
    );
  });

  it("prefers the host named in the push and ignores other pushes", () => {
    expect(
      resolveVibePushRoute({ event: "session.waiting", serverId: "named" }, ["srv"]),
    ).toContain("/h/named/");
    expect(resolveVibePushRoute({ event: "master.alert" }, ["srv"])).toBeNull();
    expect(resolveVibePushRoute({ agentId: "a" }, ["srv"])).toBeNull();
    expect(resolveVibePushRoute({ event: "card.verifying" }, [])).toBeNull();
  });
});
