// 增量读取性能慢记录，只生成维护规划；复现与前后对比由用户确认后的执行和验证阶段完成。

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
  fields: z
    .object({ site: z.string(), ms: z.string(), ts: z.string(), method: z.string() })
    .partial()
    .optional(),
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

const MAX_READ_BYTES = 8 * 1024 * 1024;

interface SourceRead {
  samples: SlowSample[];
  /** Cursor value to store after the task exists. */
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
    if (cursor !== undefined && mtime <= cursor)
      return { samples: [], next: cursor, skippedBytes: 0 };
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

const round = (n: number) => Math.round(n * 10) / 10;

interface Candidate extends SiteStats {
  source: string;
  thresholdMs: number;
  key: string;
}

const substitute = (text: string, site: string) => text.replaceAll("{site}", site);

export function createPerfSlowCheck(): CheckFn {
  return async (ctx: CheckContext): Promise<CheckOutput | null> => {
    const parsed = OptionsSchema.safeParse(ctx.options);
    if (!parsed.success) {
      throw new Error(
        `perf-slow options: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
      );
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
      if (read.skippedBytes > 0)
        notes.push(`来源「${name}」积压过多，跳过了最旧的 ${read.skippedBytes} 字节。`);
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

    // Compare with the existing tasks: a call site that already has an unfinished task is not filed again.
    const fresh = candidates.sort((a, b) => b.p95Ms / b.thresholdMs - a.p95Ms / a.thresholdMs);
    if (fresh.length === 0) {
      commit();
      return null;
    }
    const top = fresh[0]!;
    const others = fresh.slice(1);

    const findings: Finding[] = [top, ...others].slice(0, options.max_listed).map((c, i) => ({
      category: i === 0 ? "slow_primary" : "slow_other",
      subject: c.site,
      detail:
        c.source +
        ": " +
        c.slowCount +
        "/" +
        c.count +
        " 次超过 " +
        c.thresholdMs +
        "ms，p95 " +
        round(c.p95Ms) +
        "ms",
      data: {
        source: c.source,
        thresholdMs: c.thresholdMs,
        count: c.count,
        slowCount: c.slowCount,
        p95Ms: round(c.p95Ms),
        maxMs: round(c.maxMs),
        lastTs: c.lastTs,
        dedupeKey: c.key,
      },
    }));
    const repro = options.repro;
    const verifyJson = repro
      ? {
          backend: {
            perf: {
              label: top.site,
              command: substitute(repro.command, top.site),
              args: repro.args.map((arg) => substitute(arg, top.site)),
              runs: repro.runs,
              thresholdMs: repro.threshold_ms ?? top.thresholdMs,
            },
          },
        }
      : null;
    const body = [
      "## 性能慢记录：" + top.site,
      "- 来源：" +
        top.source +
        "；新增慢记录 " +
        top.slowCount +
        "/" +
        top.count +
        " 次，p95 " +
        round(top.p95Ms) +
        "ms，阈值 " +
        top.thresholdMs +
        "ms。",
      repro
        ? "- 已配置复现命令；当前未执行，待用户确认方案后复现、修复并生成前后对比证据。"
        : "- 尚未配置复现命令，请在规划中确定复现与度量方法。",
      ...others
        .slice(0, options.max_listed)
        .map(
          (candidate) =>
            "- 其它调用点：" + candidate.site + "，p95 " + round(candidate.p95Ms) + "ms",
        ),
      ...notes.map((note) => "- " + note),
    ].join("\n");
    const instructions = [
      "先只读规划，等待用户 /执行 后才进行以下工作：",
      "1. 复现慢调用并记录修复前耗时；若复现失败，向用户说明并调整方案，禁止假报已修复。",
      "2. 做最小修复并跑项目测试。",
      "3. 验证阶段在基线提交与修复提交分别运行复现命令，生成 perf-compare.json 前后耗时对比证据。",
      ...(verifyJson
        ? [
            "在确认后的执行阶段合并以下配置到 .vibe/verify.json，保留其它键；需要新增脚本时列入 copyToBaseline。",
            "\x60\x60\x60json",
            JSON.stringify(verifyJson, null, 2),
            "\x60\x60\x60",
          ]
        : []),
      "4. 无法确定安全修复时，在原生会话报告排查结果和下一步建议，等待用户决定。",
    ].join("\n");
    const title =
      "性能慢：" + top.site + "（p95 " + round(top.p95Ms) + "ms，阈值 " + top.thresholdMs + "ms）";
    return {
      title,
      body,
      findings,
      notes,
      dedupeKey: top.key,
      instructions,
      needsEvidence: true,
      acceptance:
        "- [ ] 使用同一复现命令取得基线与修复后 perf-compare.json\n- [ ] 项目测试通过且行为不变",
      commit,
    };
  };
}

export const perfSlowCheck = createPerfSlowCheck();
