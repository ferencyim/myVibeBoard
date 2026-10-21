// Hand-off summary for a freshly started master agent. Built from the board alone (cards, events,
// session history), so it works when the previous agent is gone or archived. Size-capped: the new
// agent still gets full detail from the wake messages and `vibe_show`. The framing text is the
// registered prompt `master.handoff_summary`; this module only fills its sections.

import { contentHash, lastAssessmentMarker } from "../assess/assess";
import { defaultPromptPort, type PromptPort } from "../prompts/port";
import { DEFAULT_TUNING } from "../tuning";
import type { CardView } from "../vibe/contract";
import type { VibeStore } from "../vibe/db";

export const HANDOFF_MAX_CHARS = DEFAULT_TUNING.handoffMaxChars;

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const day = (iso: string) => iso.slice(0, 16).replace("T", " ");

export interface SwitchNote {
  at: string;
  text: string;
}

interface AssessmentBody {
  assessment?: {
    clarity?: { status?: string; summary?: string };
    estimate?: { size?: string };
    recommendation?: { agent?: string; preset?: string };
  };
  applied?: { presetName?: string | null };
}

export function buildHandoff(input: {
  store: VibeStore;
  nowMs: number;
  /** Why the previous agent was replaced, plus earlier switches (newest last). */
  switches: SwitchNote[];
  prompts?: PromptPort;
  /** Size cap and look-back window (settings); defaults 3500 characters and 7 days. */
  maxChars?: number;
  recentDays?: number;
}): string {
  const { store } = input;
  const recentDays = input.recentDays ?? DEFAULT_TUNING.handoffRecentDays;
  const maxChars = input.maxChars ?? DEFAULT_TUNING.handoffMaxChars;
  const since = new Date(input.nowMs - recentDays * 24 * 60 * 60_000).toISOString();
  const tagName = new Map(store.tags.list().map((t) => [t.id, t.name]));
  const tagNames = (c: CardView) => c.tags.map((id) => tagName.get(id)).filter((n): n is string => !!n);
  const cards = store.cards.list({}).filter((c) => !c.archivedAt);

  const recent = cards.filter((c) => c.updatedAt >= since);
  const reviews: Array<{ at: string; line: string }> = [];
  for (const card of recent) {
    for (const e of store.events.list(card.id)) {
      if (e.type !== "evaluation" || e.author !== "master") continue;
      const body = e.body as AssessmentBody | null;
      const a = body?.assessment;
      if (!a?.clarity) continue;
      const verdict = a.clarity.status === "clear" ? "清晰" : "需澄清";
      const agent = body?.applied?.presetName ?? a.recommendation?.preset ?? a.recommendation?.agent;
      reviews.push({
        at: e.createdAt,
        line: `- ${card.key}（${card.column}）${verdict}${a.estimate?.size ? ` ${a.estimate.size}` : ""}${agent ? ` 推荐 ${agent}` : ""}：${clip(a.clarity.summary ?? "", 120)}`,
      });
    }
  }
  reviews.sort((x, y) => y.at.localeCompare(x.at));

  const drafts = cards
    .filter((c) => c.column === "draft")
    .map((c) => {
      const marker = lastAssessmentMarker(store.events.list(c.id));
      const state = !marker
        ? "尚未审查"
        : marker.failed
          ? "上次审查失败"
          : marker.hash !== contentHash(c, tagNames(c))
            ? "审查后已修改，需重审"
            : "已审查，等你决定";
      return { c, state };
    })
    .sort((x, y) => y.c.updatedAt.localeCompare(x.c.updatedAt))
    .slice(0, 8)
    .map((d) => `- ${d.c.key} ${clip(d.c.title, 60)}：${d.state}`);

  const done = cards
    .filter((c) => c.column === "done" && c.updatedAt >= since)
    .sort((x, y) => y.updatedAt.localeCompare(x.updatedAt))
    .slice(0, 8)
    .map((c) => `- ${c.key} ${clip(c.title, 70)}（${day(c.updatedAt)}）`);

  const switches = input.switches.slice(-5).map((s) => `- ${day(s.at)} ${clip(s.text, 120)}`);

  const text = (input.prompts ?? defaultPromptPort()).resolve("master.handoff_summary", {
    vars: {
      switches: switches.join("\n") || "- 无",
      days: String(recentDays),
      reviews: reviews.slice(0, 5).map((r) => r.line).join("\n") || "- 无",
      drafts: drafts.join("\n") || "- 没有草稿",
      done: done.join("\n") || "- 无",
    },
  });
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}
