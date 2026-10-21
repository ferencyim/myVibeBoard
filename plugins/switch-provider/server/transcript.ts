import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { switchSettings } from "../shared/settings";

const defaults = switchSettings.schema.parse({});
export const DEFAULT_LIMITS = { page: defaults.transcriptPage, maxBlock: defaults.transcriptMaxBlock };

// ponytail: one huge tool result is cut at maxBlock; raise it (setting) or stream to disk if that loses needed output
const clip = (text: string, maxBlock: number) =>
  text.length > maxBlock ? `${text.slice(0, maxBlock)}\n[cut: ${text.length - maxBlock} more characters]` : text;

function render(item: Record<string, unknown>, maxBlock: number): string | null {
  switch (item.type) {
    case "user_message":
      return `## User\n\n${item.text}`;
    case "assistant_message":
      return `## Assistant\n\n${item.text}`;
    case "reasoning":
      return `### Reasoning\n\n${item.text}`;
    case "tool_call":
      return `### Tool call: ${item.name} (${item.status})\n\n\`\`\`json\n${clip(JSON.stringify({ detail: item.detail, error: item.error }, null, 1), maxBlock)}\n\`\`\``;
    case "todo":
      return `### Todo list\n\n${clip(JSON.stringify(item.items), maxBlock)}`;
    case "error":
    case "notification":
      return `### ${item.type}\n\n${item.message}`;
    default:
      return null;
  }
}

export async function exportAgentTranscript(
  { agentId }: { agentId: string },
  { paseo }: PluginHandlerContext,
  limits: { page: number; maxBlock: number } = DEFAULT_LIMITS,
) {
  if (!/^[\w-]+$/.test(agentId)) throw new Error("Invalid agent id");
  const timeline = paseo.agents.ref(agentId).timeline;
  let page = await timeline.refetch({ direction: "tail", limit: limits.page, projection: "projected" });
  let entries = [...page.entries];
  while (page.hasOlder && page.startCursor) {
    page = await timeline.refetch({
      direction: "before",
      cursor: page.startCursor,
      limit: limits.page,
      projection: "projected",
    });
    entries = [...page.entries, ...entries];
  }
  const body = entries
    .map((entry) => render(entry.item as Record<string, unknown>, limits.maxBlock))
    .filter((block): block is string => block !== null)
    .join("\n\n");
  const dir = join(tmpdir(), "paseo-transcripts");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${agentId}.md`);
  await writeFile(path, `# Transcript of agent ${agentId}\n\n${body}\n`);
  return { path, entries: entries.length };
}
