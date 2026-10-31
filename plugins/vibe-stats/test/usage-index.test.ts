import { describe, expect, it } from "vitest";
import { ensureUsageSessionIndex } from "../server/usage-index";
import { openTestDb } from "./helpers";

describe("用量会话索引", () => {
  it("可重复初始化，且关联查询使用提供方和会话联合索引", () => {
    const db = openTestDb();
    try {
      ensureUsageSessionIndex(db);
      ensureUsageSessionIndex(db);
      const plan = db
        .prepare<{ detail: string }>(
          "EXPLAIN QUERY PLAN UPDATE usage_event SET project_id = ? WHERE provider = ? AND session_id = ?",
        )
        .all("p", "claude", "s");
      expect(plan.map((row) => row.detail).join(" ")).toContain(
        "idx_usage_event_provider_session (provider=? AND session_id=?)",
      );
    } finally {
      db.close();
    }
  });
});
