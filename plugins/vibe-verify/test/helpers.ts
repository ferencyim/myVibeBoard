import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import {
  createScriptedRunner,
  type TaskCollectorContext as CollectorContext,
} from "../server/vibe/contract/collector";

export function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) png.data.set([...rgb, 255], i * 4);
  return PNG.sync.write(png);
}

export function makeCtx(overrides: Partial<CollectorContext> = {}): CollectorContext {
  return {
    cardId: null,
    workspaceId: "ws-test",
    confirmedAt: "2026-10-19T00:00:00.000Z",
    verificationId: "ver_1",
    projectType: "web",
    projectPath: "/proj",
    worktreePath: "/proj",
    commitHash: "abc1234",
    outputDir: mkdtempSync(path.join(tmpdir(), "vibe-verify-")),
    runner: createScriptedRunner(() => undefined),
    now: () => new Date("2026-10-19T00:00:00.000Z"),
    log: () => {},
    ...overrides,
  };
}
