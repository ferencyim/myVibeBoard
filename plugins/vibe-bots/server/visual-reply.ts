import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { resolveVibeHome } from "./vibe/db/sqlite";
import { visualReplyInputSchema, visualReplyReadRpc } from "../shared/visual-reply";

export function registerVisualReply(server: PluginServerContext, authorize: (agentId: string | null | undefined) => Promise<unknown>) {
  const directory = join(resolveVibeHome(), "visual-replies");
  server.handle(visualReplyReadRpc, async ({ attachmentId }, ctx) => {
    if (ctx.callerAgentId) throw new Error("附件仅供客户端读取");
    return { html: await readFile(join(directory, `${attachmentId}.html`), "utf8"), mimeType: "text/html" as const };
  });
  server.registerAgentTool({
    name: "vibe_html_render",
    description: "在当前对话插入交互式 HTML 可视化回复。",
    input: visualReplyInputSchema,
    handler: async (input, ctx) => {
      await authorize(ctx.callerAgentId);
      if (!ctx.callerAgentId) throw new Error("工具仅供 bot 使用");
      const { title, html, height } = visualReplyInputSchema.parse(input);
      const attachmentId = randomUUID();
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, `${attachmentId}.html`), html, { encoding: "utf8", flag: "wx" });
      await server.paseo.agents.ref(ctx.callerAgentId).timeline.append({
        type: "plugin", id: `visual-reply:${attachmentId}`, kind: "visual-reply", version: 1,
        data: { title, attachmentId, ...(height === undefined ? {} : { height }) },
      });
      return { attachmentId, mimeType: "text/html" };
    },
  });
}
