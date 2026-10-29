import { describe, expect, it } from "vitest";
import { systemRoutines } from "../server/system-routines";
import { setup } from "./helpers";

describe("系统例程只读映射", () => {
  it("投影维护规则并保留原始数据", async () => {
    const h = setup({ yml: "rules:\n  - name: scheduled\n    trigger: { kind: time, cron: '* * * * *' }\n    check: { type: git }\n  - name: workload\n    trigger: { kind: workload, cards_done: 2 }\n    check: { type: git }\n" });
    await h.engine.syncRules();
    const before = h.engine.status();
    const rows = systemRoutines(before, new Date("2026-01-01T00:00:00Z"));
    expect(rows.find((row) => row.title === "scheduled")).toMatchObject({ projectId: h.project.id, schedule: { kind: "cron", expression: "* * * * *" }, nextRunAt: "2026-01-01T00:01:00.000Z", editKey: `${h.project.id}:scheduled` });
    expect(rows.find((row) => row.title === "workload")).toMatchObject({ schedule: null, nextRunAt: null });
    expect(h.engine.status()).toEqual(before);
  });
});
