import { describe, expect, it } from "vitest";
import { createDirectiveInjector, DIRECTIVE_HEADER } from "../server/directives";
import { migrateOwner, openVibeDb } from "../server/vibe/db";

function setup() {
  const db = openVibeDb({ path: ":memory:" });
  migrateOwner(db, "scheduler");
  const add = (
    id: string,
    text: string,
    scope: object,
    status = "active",
    expires: string | null = null,
  ) =>
    db
      .prepare(
        `INSERT INTO hub_directive (id,text,scope_json,kind,expires_at,issued_by,status,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        text,
        JSON.stringify(scope),
        "standing",
        expires,
        "user",
        status,
        "2026-01-01",
        "2026-01-01",
      );
  return {
    db,
    add,
    injector: createDirectiveInjector({ db, now: () => new Date("2026-10-30T00:00:00Z") }),
  };
}

describe("directive injection", () => {
  it("injects only active, scope-matching directives, marked as system material", () => {
    const { add, injector } = setup();
    add("a", "全局", { kind: "all" });
    add("b", "只给项目 P", { kind: "projects", projectIds: ["P"] });
    add("c", "只给 codex", { kind: "providers", providers: ["codex"] });
    add("d", "待确认", { kind: "all" }, "pending");
    add("e", "已过期", { kind: "all" }, "active", "2026-10-29T00:00:00Z");
    const claudeP = injector.prepare("ag1", { provider: "claude", projectId: "P" });
    expect(claudeP?.context).toContain(DIRECTIVE_HEADER);
    expect(claudeP?.context).toContain("全局");
    expect(claudeP?.context).toContain("只给项目 P");
    expect(claudeP?.context).not.toMatch(/只给 codex|待确认|已过期/);
    const codexOther = injector.prepare("ag2", { provider: "codex/gpt", projectId: "Q" });
    expect(codexOther?.context).toContain("只给 codex");
    expect(codexOther?.context).not.toContain("只给项目 P");
  });

  it("sends the full list first and later only differences, after delivery receipt", () => {
    const { db, add, injector } = setup();
    add("a", "规则甲", { kind: "all" });
    expect(injector.prepare("ag", { provider: "claude" })?.context).toContain("规则甲");
    // no receipt yet (failed start): retried in full
    const again = injector.prepare("ag", { provider: "claude" }) as { deliveryId: string };
    expect(again).not.toBeNull();
    injector.commit("ag", again.deliveryId);
    expect(injector.prepare("ag", { provider: "claude" })).toBeNull();
    add("b", "规则乙", { kind: "all" });
    const diff = injector.prepare("ag", { provider: "claude" });
    expect(diff?.context).toContain("规则乙");
    expect(diff?.context).not.toContain("规则甲");
    injector.commit("ag", diff?.deliveryId as string);
    db.prepare("UPDATE hub_directive SET status='revoked' WHERE id='a'").run();
    const removed = injector.prepare("ag", { provider: "claude" });
    expect(removed?.context).toContain("已失效");
    expect(removed?.context).toContain("规则甲");
  });

  it("injects nothing when no directive applies", () => {
    expect(setup().injector.prepare("ag", { provider: "claude" })).toBeNull();
  });
});
