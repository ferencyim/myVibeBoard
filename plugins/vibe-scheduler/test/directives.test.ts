import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { applyBlock, BLOCK_BEGIN, BLOCK_END, syncDirectiveFiles } from "../server/directive-files";
import { createDirectiveService } from "../server/directives";
import { migrateOwner, openVibeDb } from "../server/vibe/db";

function setup() {
  const db = openVibeDb({ path: ":memory:" });
  migrateOwner(db, "scheduler");
  const clock = { ms: Date.parse("2026-10-30T00:00:00.000Z") };
  const pause = { create: vi.fn(async () => ({ id: "p1" })), remove: vi.fn() };
  const notifyUser = vi.fn();
  const service = createDirectiveService({
    db,
    now: () => new Date(clock.ms),
    pause,
    notifyUser,
  });
  const at = (hours: number) => new Date(clock.ms + hours * 3_600_000).toISOString();
  return { service, clock, pause, notifyUser, at };
}

describe("directive permissions", () => {
  it("a bot's short temporary directive takes effect at once and notifies the user", async () => {
    const { service, notifyUser, at } = setup();
    const d = await service.issue({
      text: "暂停构建",
      kind: "temporary",
      expiresAt: at(2),
      issuedBy: "bot",
    });
    expect(d.status).toBe("active");
    expect(notifyUser).toHaveBeenCalledOnce();
  });

  it("a bot's standing directive stays pending until the user confirms", async () => {
    const { service, notifyUser } = setup();
    const d = await service.issue({ text: "长期规则", kind: "standing", issuedBy: "bot" });
    expect(d.status).toBe("pending");
    expect(notifyUser).not.toHaveBeenCalled();
    expect(service.list("active")).toEqual([]);
    expect((await service.confirm(d.id)).status).toBe("active");
  });

  it("rejects a bot temporary directive longer than 24 hours", async () => {
    const { service, at } = setup();
    await expect(
      service.issue({ text: "x", kind: "temporary", expiresAt: at(25), issuedBy: "bot" }),
    ).rejects.toThrow("24 小时");
    expect(service.list()).toEqual([]);
    // the user is not subject to the limit
    const d = await service.issue({
      text: "x",
      kind: "temporary",
      expiresAt: at(72),
      issuedBy: "user",
    });
    expect(d.status).toBe("active");
  });

  it("temporary directives need a future expiry", async () => {
    const { service } = setup();
    await expect(
      service.issue({ text: "x", kind: "temporary", issuedBy: "user" }),
    ).rejects.toThrow();
  });

  it("creates the pause rule on activation and removes it on revoke", async () => {
    const { service, pause, at } = setup();
    const d = await service.issue({
      text: "维护窗口",
      kind: "temporary",
      expiresAt: at(3),
      issuedBy: "bot",
      pause: { scope: "pg:*" },
    });
    expect(pause.create).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "pg:*", until: at(3), directiveId: d.id }),
    );
    expect(service.list("active")[0]?.pauseId).toBe("p1");
    await service.revoke(d.id);
    expect(pause.remove).toHaveBeenCalledWith("p1");
    expect(service.list("active")).toEqual([]);
  });

  it("a standing pause only starts when confirmed", async () => {
    const { service, pause, at } = setup();
    const d = await service.issue({
      text: "x",
      kind: "standing",
      issuedBy: "bot",
      pause: { scope: "build", until: at(4) },
    });
    expect(pause.create).not.toHaveBeenCalled();
    await service.confirm(d.id);
    expect(pause.create).toHaveBeenCalledOnce();
  });

  it("expires active directives when due", async () => {
    const { service, clock, at } = setup();
    await service.issue({ text: "x", kind: "temporary", expiresAt: at(1), issuedBy: "user" });
    expect(service.expireDue()).toEqual([]);
    clock.ms += 2 * 3_600_000;
    expect(service.expireDue()).toHaveLength(1);
    expect(service.list("expired")).toHaveLength(1);
    expect(service.list("active")).toEqual([]);
  });
});

describe("marker block", () => {
  it("appends to a file without a block and keeps the original bytes as prefix", () => {
    const original = "# 规则\n内容";
    const next = applyBlock(original, "暂无") as string;
    expect(next.startsWith(original)).toBe(true);
    expect(next).toContain(`${BLOCK_BEGIN}\n暂无\n${BLOCK_END}`);
  });

  it("replaces only the block content and leaves outside bytes untouched", () => {
    const before = "头\r\n\n";
    const after = "\n尾 \t\n";
    const original = `${before}${BLOCK_BEGIN}\r\n旧内容\r\n${BLOCK_END}${after}`;
    const next = applyBlock(original, "新内容") as string;
    expect(next.startsWith(before + BLOCK_BEGIN)).toBe(true);
    expect(next.endsWith(BLOCK_END + after)).toBe(true);
    expect(next).toContain("新内容");
    expect(next).not.toContain("旧内容");
  });

  it("skips a broken marker pair", () => {
    expect(applyBlock(`${BLOCK_BEGIN}\n没有结束`, "暂无")).toBeNull();
  });

  it("syncs temp files only: updates existing files and never creates missing ones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vibe-hub-dir-"));
    const claude = join(dir, "CLAUDE.md");
    const missing = join(dir, "AGENTS.md");
    writeFileSync(claude, "keep\n");
    const logs: string[] = [];
    const { service, at } = setup();
    const d = await service.issue({
      text: "全员注意",
      kind: "temporary",
      expiresAt: at(1),
      issuedBy: "user",
    });
    const project = await service.issue({
      text: "仅项目",
      kind: "standing",
      issuedBy: "user",
      scope: { kind: "projects", projectIds: ["p"] },
    });
    syncDirectiveFiles(
      [
        { path: claude, provider: "claude" },
        { path: missing, provider: "codex" },
      ],
      service.list("active"),
      (m) => logs.push(m),
    );
    const text = readFileSync(claude, "utf8");
    expect(text.startsWith("keep\n")).toBe(true);
    expect(text).toContain("全员注意");
    expect(text).not.toContain("仅项目");
    expect(readdirSync(dir)).toEqual(["CLAUDE.md"]);
    expect(logs.join()).toContain("不创建");
    await service.revoke(d.id);
    await service.revoke(project.id);
    syncDirectiveFiles([{ path: claude, provider: "claude" }], service.list("active"));
    expect(readFileSync(claude, "utf8")).toContain(`${BLOCK_BEGIN}\n暂无\n${BLOCK_END}`);
    unlinkSync(claude);
    rmdirSync(dir);
  });
});
