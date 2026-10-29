import { z } from "zod";
import { SendAgentMessageRequestSchema } from "@getpaseo/protocol/messages";
import type { VibeDb } from "../vibe/db";

const UserInputSchema = SendAgentMessageRequestSchema.pick({
  agentId: true,
  text: true,
  images: true,
  attachments: true,
}).extend({
  sessionMode: z.string().optional(),
  messageId: z.string(),
  workspaceId: z.string().nullable(),
});
const GrantSchema = z.object({
  input: UserInputSchema,
  spent: z.boolean(),
  destination: z.string().optional(),
  workspaceId: z.string().optional(),
  mainId: z.string().optional(),
});
const InputsSchema = z.array(GrantSchema).max(20);
export type StoredGrant = z.infer<typeof GrantSchema>;
export const PROJECT_INPUT_BYTES = 8 * 1024 * 1024;

/** Daemon-only, bounded authority receipts. Never synced into project files or public logs. */
export function createInputPersistence(db: VibeDb) {
  function read(agentId: string): StoredGrant[] {
    const row = db
      .prepare("SELECT value FROM vibe_meta WHERE key = ?")
      .get("project.agent.inputs:" + agentId);
    if (!row) return [];
    const parsed = z.object({ value: z.string() }).parse(row);
    return InputsSchema.parse(JSON.parse(parsed.value));
  }
  function write(agentId: string, inputs: StoredGrant[]) {
    const serialized = JSON.stringify(InputsSchema.parse(inputs));
    if (Buffer.byteLength(serialized, "utf8") > PROJECT_INPUT_BYTES)
      throw new Error("待路由用户输入超过存储上限，请在任务 #1 重发该需求与附件");
    db.prepare(
      "INSERT INTO vibe_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run("project.agent.inputs:" + agentId, serialized);
  }
  return { read, write };
}
