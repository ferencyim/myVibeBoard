// Hand-off summary uses completed task snapshots and the persisted switch history.

import { defaultPromptPort, type PromptPort } from "../prompts/port";
import { DEFAULT_TUNING } from "../tuning";
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
  const done = store.tasks
    .list({ phase: "completed" })
    .filter((task) => task.confirmedAt && task.confirmedAt >= since)
    .slice(-8)
    .toReversed()
    .map(
      (task) =>
        "- " +
        task.workspaceId +
        " " +
        clip(task.plan?.goal ?? "", 70) +
        "：" +
        clip(task.summary, 160),
    );

  const switches = input.switches.slice(-5).map((s) => `- ${day(s.at)} ${clip(s.text, 120)}`);

  const text = (input.prompts ?? defaultPromptPort()).resolve("master.handoff_summary", {
    vars: {
      switches: switches.join("\n") || "- 无",
      days: String(recentDays),
      done: done.join("\n") || "- 无",
    },
  });
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}
