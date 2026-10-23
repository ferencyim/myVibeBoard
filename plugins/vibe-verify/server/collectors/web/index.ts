import type { CollectorContext } from "../context";
// Web evidence collector: desktop + mobile screenshots, interaction GIF, console errors and
// before/after comparison, driven by `<worktree>/.vibe/verify.json` (see ../common.ts).
import type {
  CollectResult,
  CollectorAvailability,
  EvidenceArtifact,
  EvidenceCollector,
} from "../../vibe/contract/collector";
import {
  ServerRegistry,
  createNodeServerLauncher,
  loadVerifyConfig,
  writeArtifact,
  type ServerLauncher,
  type ServerCommand,
  type VerifyConfig,
} from "../common";
import { createPlaywrightDriver, type BrowserDriver, type Viewport } from "./driver";
import { compareScreenshots, encodeGif } from "./images";

export const DESKTOP: Viewport = { width: 1280, height: 800 };
export const MOBILE: Viewport = { width: 390, height: 844 };

export interface WebCollectorOptions {
  driver?: BrowserDriver;
  launcher?: ServerLauncher;
  loadConfig?: (ctx: CollectorContext) => VerifyConfig;
}

export function createWebCollector(options: WebCollectorOptions = {}): EvidenceCollector {
  const driver = options.driver ?? createPlaywrightDriver();
  const launcher = options.launcher ?? createNodeServerLauncher();
  const loadConfig = options.loadConfig ?? ((ctx) => loadVerifyConfig(ctx.worktreePath));
  const servers = new ServerRegistry();

  async function resolveBase(
    ctx: CollectorContext,
    target: { url?: string; server?: ServerCommand },
    worktree: string,
  ): Promise<string> {
    if (target.server)
      servers.add(ctx.verificationId, await launcher.start(target.server, worktree));
    const url = target.url ?? target.server?.readyUrl;
    if (!url) throw new Error("Web 目标需要配置 url 或 server.readyUrl");
    return url;
  }

  /** Opens `entry`, takes the screenshot of each viewport; returns PNGs by viewport name. */
  async function shoot(base: string, entry: string, errors: string[]) {
    const shots: Record<"desktop" | "mobile", Buffer> = {} as never;
    for (const [name, viewport] of [
      ["desktop", DESKTOP],
      ["mobile", MOBILE],
    ] as const) {
      const page = await driver.open(viewport);
      try {
        await page.goto(new URL(entry, base).toString());
        shots[name] = await page.screenshot();
        errors.push(...page.consoleErrors().map((e) => `[${name}] ${e}`));
      } finally {
        await page.close();
      }
    }
    return shots;
  }

  return {
    id: "web",
    projectTypes: ["web"],

    async detect(ctx): Promise<CollectorAvailability> {
      const probe = await driver.probe();
      if (!probe.ok) return { available: false, reason: probe.reason };
      const web = loadConfig(ctx).web;
      if (!web || (!web.url && !web.server)) {
        return {
          available: false,
          reason: "未配置 Web 目标：请在 .vibe/verify.json 设置 web.url 或 web.server",
        };
      }
      return { available: true };
    },

    async collect(ctx): Promise<CollectResult> {
      const web = loadConfig(ctx).web;
      if (!web) throw new Error(".vibe/verify.json 没有 web 配置段");
      const prefix = ctx.check ? `${ctx.check.id}-` : "";
      const artifacts: EvidenceArtifact[] = [];
      const notes: string[] = [];
      const errors: string[] = [];
      let judgement: CollectResult["judgement"] = "pass";

      const base = await resolveBase(ctx, web, ctx.worktreePath);
      const after = await shoot(base, web.entry, errors);
      for (const name of ["desktop", "mobile"] as const) {
        artifacts.push(
          writeArtifact(
            ctx,
            "screenshot",
            `${prefix}after-${name}.png`,
            after[name],
            `${name} width`,
          ),
        );
      }

      if (web.steps.length > 0) {
        const page = await driver.open(DESKTOP);
        try {
          await page.goto(new URL(web.entry, base).toString());
          const frames = [await page.screenshot()];
          try {
            for (const step of web.steps) {
              await page.step(step, base);
              frames.push(await page.screenshot());
            }
          } catch (e) {
            judgement = "fail";
            notes.push(`交互步骤失败： ${String(e)}`);
            frames.push(await page.screenshot());
          }
          errors.push(...page.consoleErrors().map((e) => `[interaction] ${e}`));
          artifacts.push(
            writeArtifact(ctx, "gif", `${prefix}interaction.gif`, encodeGif(frames), "interaction"),
          );
        } finally {
          await page.close();
        }
      }

      if (web.baseline) {
        const b = web.baseline;
        const beforeErrors: string[] = [];
        const baseBefore = await resolveBase(ctx, b, b.path);
        const before = await shoot(baseBefore, web.entry, beforeErrors);
        for (const name of ["desktop", "mobile"] as const) {
          artifacts.push(
            writeArtifact(
              ctx,
              "screenshot",
              `${prefix}before-${name}.png`,
              before[name],
              `before, ${name} width`,
            ),
          );
          const cmp = compareScreenshots(before[name], after[name]);
          artifacts.push(
            writeArtifact(
              ctx,
              "screenshot",
              `${prefix}compare-${name}.png`,
              cmp.composite,
              `before | after | diff, ${name} width`,
            ),
          );
          notes.push(
            `${name}: ${(cmp.changedRatio * 100).toFixed(2)}% 的像素相较基线发生变化${b.commitHash ? ` ${b.commitHash}` : ""}`,
          );
        }
      } else {
        notes.push("未配置基线，已跳过前后对比");
      }

      if (errors.length > 0) {
        artifacts.push(
          writeArtifact(
            ctx,
            "log",
            `${prefix}console-errors.txt`,
            errors.join("\n") + "\n",
            "console errors",
          ),
        );
        notes.push(`${errors.length} 条控制台或页面错误已采集`);
        if (judgement === "pass") judgement = "doubt";
      } else {
        notes.push("未发现控制台错误");
      }
      return { artifacts, judgement, notes, degraded: false };
    },

    async dispose(ctx) {
      await servers.stopAll(ctx.verificationId);
      await driver.close();
    },
  };
}
