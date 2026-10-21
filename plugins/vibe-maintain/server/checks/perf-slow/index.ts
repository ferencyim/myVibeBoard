// "perf-slow" check (WP-47): reads slow records registered in .vibe/maintenance.yml (JSON Lines request
// logs, benchmark results, MySQL/PostgreSQL slow logs), keeps what is new since the last run, groups
// it by call site, skips sites that already have an open card, reproduces the worst one and files it.
//
//   rules:
//     - name: perf-slow
//       trigger: { kind: time, cron: "0 4 * * *" }
//       check:
//         type: perf-slow
//         sources:
//           - { name: api, kind: jsonl, path: logs/access.jsonl, threshold_ms: 500,
//               fields: { site: route, ms: duration_ms, ts: time } }
//           - { kind: bench-json, path: bench/result.json, threshold_ms: 50 }
//           - { kind: mysql-slow, path: /var/log/mysql/slow.log, threshold_ms: 1000 }
//         repro: { command: node, args: [bench/run.js, "{site}"], runs: 3 }
//       output: fix            # reproduced -> worker + before/after evidence; otherwise a draft card
//       agent: codex
//       priority: low
//       daily_cap: 1
//
// Reproduction: `repro` is run `runs` times in the repository; its median wall time above the threshold
// means "reproduced". The same command goes into the card's verify config (backend.perf), so vibe-verify
// measures it again before (baseline worktree) and after the fix. Without `repro`, or when the slowness
// does not reproduce, the card is a draft with the investigation notes instead of an automatic fix.

import { execFile } from "node:child_process";
import { open, stat } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { z } from "zod";
import type { CheckContext, CheckFn, CheckOutput, Finding } from "../../types";
import {
  SOURCE_KINDS,
  TIME_UNITS,
  aggregate,
  parseBenchJson,
  parseJsonl,
  parseMysqlSlow,
  parsePgLog,
  type SiteStats,
  type SlowSample,
  type SourceKind,
} from "./parsers";

export * from "./parsers";

const SourceSchema = z.object({
  name: z.string().min(1).optional(),
  kind: z.enum(SOURCE_KINDS as [SourceKind, ...SourceKind[]]),
  /** Relative to the repository root unless absolute. */
  path: z.string().min(1),
  threshold_ms: z.number().positive(),
  /** Slow samples needed before a call site counts. */
  min_count: z.number().int().positive().default(1),
  /** jsonl only: names of the fields holding the call site, the duration and the timestamp. */
  fields: z.object({ site: z.string(), ms: z.string(), ts: z.string(), method: z.string() }).partial().optional(),
  unit: z.enum(TIME_UNITS as [string, ...string[]]).default("ms"),
});
const ReproSchema = z.object({
  command: z.string().min(1),
  /** `{site}` is replaced by the call site. */
  args: z.array(z.string()).default([]),
  runs: z.number().int().min(1).max(20).default(3),
  threshold_ms: z.number().positive().optional(),
  timeout_s: z.number().positive().default(300),
});
const OptionsSchema = z.object({
  sources: z.array(SourceSchema).min(1),
  repro: ReproSchema.optional(),
  max_listed: z.number().int().positive().default(10),
});
export type PerfSlowOptions = z.output<typeof OptionsSchema>;

/** Runs a reproduction command once; injectable for tests. */
export type BenchRunner = (input: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}) => Promise<{ exitCode: number; durationMs: number; output: string }>;

export const execBench: BenchRunner = ({ command, args, cwd, timeoutMs }) =>
  new Promise((resolve) => {
    const started = Date.now();
    execFile(
      command,
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        shell: process.platform === "win32" && /^(npm|npx|pnpm|yarn)$/.test(command),
      },
      (error, stdout, stderr) => {
        const code = (error as { code?: unknown } | null)?.code;
        resolve({
          exitCode: error ? (typeof code === "number" ? code : 1) : 0,
          durationMs: Date.now() - started,
          output: `${stdout}${stderr}`.slice(-2000),
        });
      },
    );
  });

const MAX_READ_BYTES = 8 * 1024 * 1024;

interface SourceRead {
  samples: SlowSample[];
  /** Cursor value to store after the card exists. */
  next: number;
  skippedBytes: number;
}

/** Reads only what is new since `cursor` (byte offset; bench files: mtime) and parses it. */
export async function readSource(
  source: z.output<typeof SourceSchema>,
  file: string,
  cursor: number | undefined,
): Promise<SourceRead | null> {
  const info = await stat(file).catch(() => null);
  if (!info) return null;
  if (source.kind === "bench-json") {
    const mtime = Math.floor(info.mtimeMs);
    if (cursor !== undefined && mtime <= cursor) return { samples: [], next: cursor, skippedBytes: 0 };
    const handle = await open(file, "r");
    try {
      const buffer = Buffer.alloc(Math.min(info.size, MAX_READ_BYTES));
      await handle.read(buffer, 0, buffer.length, 0);
      return { samples: parseBenchJson(buffer.toString("utf8")), next: mtime, skippedBytes: 0 };
    } finally {
      await handle.close();
    }
  }
  let from = cursor ?? 0;
  if (info.size < from) from = 0; // rotated / truncated
  let skippedBytes = 0;
  if (info.size - from > MAX_READ_BYTES) {
    skippedBytes = info.size - MAX_READ_BYTES - from;
    from = info.size - MAX_READ_BYTES;
  }
  if (info.size === from) return { samples: [], next: from, skippedBytes };
  const handle = await open(file, "r");
  let buffer: Buffer;
  try {
    buffer = Buffer.alloc(info.size - from);
    await handle.read(buffer, 0, buffer.length, from);
  } finally {
    await handle.close();
  }
  if (skippedBytes > 0) {
    const nl = buffer.indexOf(0x0a);
    if (nl >= 0) {
      buffer = buffer.subarray(nl + 1);
      from += nl + 1;
    }
  }
  const lastNl = buffer.lastIndexOf(0x0a);
  const complete = lastNl < 0 ? buffer.subarray(0, 0) : buffer.subarray(0, lastNl + 1);
  const text = complete.toString("utf8");
  if (source.kind === "mysql-slow") {
    const { samples, consumed } = parseMysqlSlow(text);
    return { samples, next: from + Buffer.byteLength(text.slice(0, consumed)), skippedBytes };
  }
  const samples =
    source.kind === "jsonl"
      ? parseJsonl(text, source.fields, source.unit as "ms" | "s" | "us" | "ns")
      : parsePgLog(text);
  return { samples, next: from + complete.length, skippedBytes };
}

const median = (values: number[]) => {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};
const round = (n: number) => Math.round(n * 10) / 10;

interface Candidate extends SiteStats {
  source: string;
  thresholdMs: number;
  key: string;
}

interface ReproResult {
  command: string;
  args: string[];
  runs: number[];
  medianMs: number;
  failed: boolean;
  output: string;
  reproduced: boolean;
  thresholdMs: number;
}

const substitute = (text: string, site: string) => text.replaceAll("{site}", site);

export function createPerfSlowCheck(deps: { bench?: BenchRunner } = {}): CheckFn {
  const bench = deps.bench ?? execBench;
  return async (ctx: CheckContext): Promise<CheckOutput | null> => {
    const parsed = OptionsSchema.safeParse(ctx.options);
    if (!parsed.success) {
      throw new Error(`perf-slow options: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    }
    const options = parsed.data;
    const repoPath = ctx.project.repoPath;
    const notes: string[] = [];
    const candidates: Candidate[] = [];
    const nextCursors = new Map<string, number>();

    for (const [i, source] of options.sources.entries()) {
      const name = source.name ?? `${source.kind}-${basename(source.path)}`;
      const file = isAbsolute(source.path) ? source.path : join(repoPath, source.path);
      const cursorKey = `${i}:${name}`;
      const read = await readSource(source, file, ctx.cursor.get(cursorKey));
      if (!read) {
        notes.push(`来源「${name}」的文件不存在：${source.path}`);
        continue;
      }
      nextCursors.set(cursorKey, read.next);
      if (read.skippedBytes > 0) notes.push(`来源「${name}」积压过多，跳过了最旧的 ${read.skippedBytes} 字节。`);
      for (const stats of aggregate(read.samples, source.threshold_ms)) {
        if (stats.slowCount < source.min_count) continue;
        candidates.push({
          ...stats,
          source: name,
          thresholdMs: source.threshold_ms,
          key: `perf-slow:${name}:${stats.site}`.toLowerCase(),
        });
      }
    }
    const commit = () => {
      for (const [key, value] of nextCursors) ctx.cursor.set(key, value);
    };

    // Compare with the existing cards: a call site that already has an open card is not filed again.
    const open = candidates.filter((c) => ctx.hasOpenCard(c.key));
    const fresh = candidates.filter((c) => !ctx.hasOpenCard(c.key)).sort((a, b) => b.p95Ms / b.thresholdMs - a.p95Ms / a.thresholdMs);
    if (fresh.length === 0) {
      commit();
      return null;
    }
    const top = fresh[0]!;
    const others = fresh.slice(1);
    if (open.length) notes.push(`${open.length} 个调用点已有未完成的卡片，已跳过：${open.map((c) => c.site).join("、")}`);

    // ---- reproduce ----------------------------------------------------------------------------
    let repro: ReproResult | null = null;
    if (options.repro) {
      const cfg = options.repro;
      const args = cfg.args.map((a) => substitute(a, top.site));
      const command = substitute(cfg.command, top.site);
      const runs: number[] = [];
      let failed = false;
      let output = "";
      for (let n = 0; n < cfg.runs; n++) {
        const res = await bench({ command, args, cwd: repoPath, timeoutMs: cfg.timeout_s * 1000 });
        runs.push(res.durationMs);
        output = res.output;
        if (res.exitCode !== 0) {
          failed = true;
          break;
        }
      }
      const thresholdMs = cfg.threshold_ms ?? top.thresholdMs;
      const medianMs = median(runs);
      repro = { command, args, runs, medianMs, failed, output, reproduced: !failed && medianMs > thresholdMs, thresholdMs };
    }

    const automatic = repro?.reproduced === true;
    const findings: Finding[] = [top, ...others].slice(0, options.max_listed).map((c, i) => ({
      category: i === 0 ? "slow_primary" : "slow_other",
      subject: c.site,
      detail: `${c.source}: ${c.slowCount}/${c.count} 次超过 ${c.thresholdMs}ms，p95 ${round(c.p95Ms)}ms，最大 ${round(c.maxMs)}ms`,
      data: { source: c.source, thresholdMs: c.thresholdMs, count: c.count, slowCount: c.slowCount, p95Ms: round(c.p95Ms), maxMs: round(c.maxMs), meanMs: round(c.meanMs), lastTs: c.lastTs, dedupeKey: c.key },
    }));
    if (repro) {
      findings.push({
        category: "repro",
        subject: top.site,
        detail: repro.failed
          ? `复现命令失败：${repro.output.trim().slice(-300)}`
          : `复现命令 ${repro.runs.length} 次耗时 ${repro.runs.join("/")}ms，中位 ${round(repro.medianMs)}ms，阈值 ${repro.thresholdMs}ms，${repro.reproduced ? "已复现" : "未复现"}`,
        data: repro,
      });
    }

    const verifyJson = repro && {
      backend: {
        perf: {
          label: top.site,
          command: repro.command,
          args: repro.args,
          runs: options.repro!.runs,
          thresholdMs: repro.thresholdMs,
          beforeMs: round(repro.medianMs),
        },
      },
    };

    const body = [
      `## 性能慢记录：${top.site}`,
      "",
      `- 来源：${top.source}；新增记录中 ${top.slowCount}/${top.count} 次超过阈值 ${top.thresholdMs}ms，p95 ${round(top.p95Ms)}ms，最大 ${round(top.maxMs)}ms${top.lastTs ? `，最近一次 ${top.lastTs}` : ""}`,
      repro
        ? repro.failed
          ? `- 复现：命令 \`${[repro.command, ...repro.args].join(" ")}\` 执行失败，未能复现。`
          : `- 复现：\`${[repro.command, ...repro.args].join(" ")}\` 运行 ${repro.runs.length} 次（${repro.runs.join("/")}ms），中位 ${round(repro.medianMs)}ms，${repro.reproduced ? "**已复现**（超过" : "**未复现**（未超过"} ${repro.thresholdMs}ms）`
        : "- 复现：规则未配置 `repro` 命令，无法自动复现与度量修复效果。",
      automatic ? "" : "- **结论：没有把握自动修复，已降级为草稿卡**，供人工或总 agent 评估后再决定。",
      "",
      ...(others.length
        ? [
            "### 其它超阈值调用点",
            ...others.slice(0, options.max_listed).map((c) => `- ${c.site}（${c.source}）：p95 ${round(c.p95Ms)}ms，${c.slowCount}/${c.count} 次超阈值`),
            "",
          ]
        : []),
      ...(notes.length ? ["### 说明", ...notes.map((n) => `- ${n}`), ""] : []),
      "_已知限制：数据库慢日志按语句指纹（字面量替换为 ?）去重；非标准日志格式可能无法解析。_",
    ]
      .filter((l) => l !== "")
      .join("\n");

    const instructions = automatic
      ? [
          "# 性能慢记录修复任务",
          `1. 先复现并记录“修复前”耗时：运行 \`${[repro!.command, ...repro!.args].join(" ")}\`（中位 ${round(repro!.medianMs)}ms，阈值 ${repro!.thresholdMs}ms）。`,
          "2. 定位热点（查询、循环里的 IO、缺索引、重复计算等），做最小修复，不改变行为；补/调整测试。",
          "3. 在 worktree 的 `.vibe/verify.json` 合并写入下面的 backend.perf 段（保留文件里已有的其它键）。验证阶段会在基线（修复前的提交）和当前提交上各跑一遍该命令，生成「修复前 vs 修复后」耗时对比证据。",
          "   如果复现命令需要你新增的脚本，把脚本相对路径列入 `copyToBaseline`，验证时会复制到基线目录。",
          "```json",
          JSON.stringify(verifyJson, null, 2),
          "```",
          "4. 修复后再跑一遍复现命令与项目测试，在最终报告里写出前后耗时。",
          "5. 如果找不到有把握的修复：不要提交代码改动，用 `vibe_comment` 写下排查结论（复现步骤、怀疑的热点、已排除项、建议），并在最终报告以 `PERF-INCONCLUSIVE:` 开头，由人工决定下一步。",
        ].join("\n")
      : undefined;

    const title = `性能慢：${top.site}（p95 ${round(top.p95Ms)}ms，阈值 ${top.thresholdMs}ms）${automatic ? "" : repro && !repro.failed ? "（未复现）" : ""}`;
    return {
      title,
      body,
      findings,
      notes,
      dedupeKey: top.key,
      instructions,
      forceDraft: !automatic,
      needsEvidence: automatic ? true : undefined,
      acceptance: automatic
        ? [
            `- [ ] 复现命令修复后中位耗时 ≤ ${repro!.thresholdMs}ms，且明显低于修复前（${round(repro!.medianMs)}ms）`,
            "- [ ] 证据包含「修复前 vs 修复后」耗时对比（perf-compare.json）",
            "- [ ] 项目测试通过，行为不变",
          ].join("\n")
        : undefined,
      commit,
    };
  };
}

export const perfSlowCheck = createPerfSlowCheck();
