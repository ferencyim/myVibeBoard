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

  it("预测超过一年的闰日，并保留维护规则的单值步长语义", async () => {
    const h = setup({ yml: "rules:\n  - name: leap\n    trigger: { kind: time, cron: '0 0 29 2 *' }\n    check: { type: git }\n  - name: stepped\n    trigger: { kind: time, cron: '5/15 * * * *' }\n    check: { type: git }\n" });
    await h.engine.syncRules();
    const rows = systemRoutines(h.engine.status(), new Date(2026, 0, 1, 0, 5));
    const leapAt = new Date(rows.find((row) => row.title === "leap")!.nextRunAt!);
    expect([leapAt.getFullYear(), leapAt.getMonth(), leapAt.getDate(), leapAt.getHours()]).toEqual([2028, 1, 29, 0]);
    const stepped = rows.find((row) => row.title === "stepped")!;
    expect(stepped.schedule?.expression).toBe("5,20,35,50 * * * *");
    expect(new Date(stepped.nextRunAt!).getMinutes()).toBe(20);
  });
});
