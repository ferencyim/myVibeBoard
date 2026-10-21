import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

// Texts of the compacted history. Placeholders are replaced in one pass ({{name}}); unknown ones become empty.
// The first line of the summary becomes the new agent's title, so keep {{title}} there.
export const DEFAULT_SUMMARY_HEADER = [
  "{{title}}",
  "",
  "This session moved to a new provider and its history was too large for the new model's context window.",
  "Earlier history is compacted below: your messages and the assistant's text are kept, tool calls are one line each, and errors are kept in full.",
  "The detailed transcript is at {{transcriptPath}}. Each entry's [L<first>-L<last>] pointer gives its line range there. Read or search those lines when you need more detail. Long tool blocks may be cut; images and reasoning are omitted.",
  "Do not resume, repeat or finish earlier work on your own. Wait for the user's next message and answer only that.",
  "",
].join("\n");

export const DEFAULT_SUMMARY_ACK =
  "Understood. I will use the compacted history and the full transcript when I need details.";

export const DEFAULT_TRANSCRIPT_PROMPT = [
  `You are continuing the session of agent {{agentId}} ("{{title}}"), which ran on {{provider}}.`,
  "Its full transcript, including tool calls and results, is in {{path}}. Read the whole file before you act, then continue where that agent stopped.",
].join("\n");

export const switchSettings = defineSettings({
  id: "preferences",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Compaction: how much of the history is kept and where the target is. All defaults equal the original constants. */
    keepTurns: z.number().int().min(1).max(100).default(10),
    /** Percent of the new model's context window the compacted session may use (room for its own instructions and new work). */
    targetPercent: z.number().int().min(10).max(95).default(60),
    /** Context window assumed when the daemon reports none (tokens). */
    defaultWindowTokens: z.number().int().min(1000).max(10_000_000).default(200_000),
    /** Longest tool call / result kept in the saved transcript (characters). */
    transcriptBlockCap: z.number().int().min(500).max(1_000_000).default(20_000),
    /** Longest file / commit / task list in the summary. */
    listCap: z.number().int().min(5).max(500).default(40),
    /** Timeline entries fetched per request when exporting a transcript, and the longest block kept there. */
    transcriptPage: z.number().int().min(50).max(5000).default(500),
    transcriptMaxBlock: z.number().int().min(500).max(1_000_000).default(20_000),
    /** Texts. Empty = the default. */
    summaryHeader: z.string().default(DEFAULT_SUMMARY_HEADER),
    summaryAck: z.string().default(DEFAULT_SUMMARY_ACK),
    transcriptPrompt: z.string().default(DEFAULT_TRANSCRIPT_PROMPT),
  }),
});

export type SwitchSettings = z.output<typeof switchSettings.schema>;

/** One-pass `{{name}}` replacement; substituted values are never scanned again. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, name: string) => vars[name] ?? "");
}

/** An empty text means "use the default". */
export const textOrDefault = (text: string, fallback: string) => (text.trim() ? text : fallback);
