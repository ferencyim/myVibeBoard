import { z } from "zod";
import {
  TextAttachmentSchema,
  ReviewAttachmentSchema,
  AgentCreateRequestSchema,
  WorkspaceCreateRequestSchema,
} from "@getpaseo/protocol/messages";
import type { ComposerAttachment } from "@/attachments/types";
import { AttachmentMetadataSchema, UserComposerAttachmentSchema } from "@/stores/draft-store/state";

const ContextAttachmentFields = {
  id: z.string(),
  title: z.string(),
  subtitle: z.string().optional(),
  text: z.string(),
  url: z.string().nullable().optional(),
};
const BrowserElementSchema = z.object({
  url: z.string(),
  selector: z.string(),
  tag: z.string(),
  text: z.string(),
  outerHTML: z.string(),
  computedStyles: z.record(z.string(), z.string()),
  boundingRect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  reactSource: z
    .object({
      fileName: z.string().nullable(),
      lineNumber: z.number().nullable(),
      columnNumber: z.number().nullable(),
      componentName: z.string().nullable(),
    })
    .nullable(),
  parentChain: z.array(z.string()),
  children: z.array(z.string()),
  comment: z.string().optional(),
  screenshot: AttachmentMetadataSchema.optional(),
  formatted: z.string(),
});
const ComposerAttachmentSchema: z.ZodType<ComposerAttachment> = z.union([
  UserComposerAttachmentSchema,
  z.object({ kind: z.literal("browser_element"), attachment: BrowserElementSchema }),
  z.object({
    kind: z.enum([
      "forge.change_request_comment",
      "forge.change_request_review",
      "forge.change_request_check",
      "github.pull_request_comment",
      "github.pull_request_review",
      "github.pull_request_check",
    ]),
    ...ContextAttachmentFields,
  }),
  z.object({
    kind: z.literal("chat_history"),
    id: z.string(),
    attachment: TextAttachmentSchema,
    source: z.object({
      serverId: z.string(),
      agentId: z.string(),
      boundaryMessageId: z.string().nullable().optional(),
      boundaryCursor: z.object({ epoch: z.string(), seq: z.number() }).nullable().optional(),
      itemCount: z.number().optional(),
    }),
  }),
  z.object({
    kind: z.literal("review"),
    attachment: ReviewAttachmentSchema,
    reviewDraftKey: z.string(),
    commentCount: z.number(),
  }),
]);

export const FirstMessageOutboxInputSchema = z
  .object({
    id: z.string().min(1),
    hostId: z.string().min(1),
    projectId: z.string().min(1),
    source: WorkspaceCreateRequestSchema.shape.source,
    config: AgentCreateRequestSchema.shape.config,
    plannerPresetId: z.string().min(1).optional(),
    text: z.string(),
    attachments: z.array(ComposerAttachmentSchema),
  })
  .superRefine((input, ctx) => {
    if (input.source.kind !== "worktree" || input.source.projectId !== input.projectId) {
      ctx.addIssue({ code: "custom", message: "离线新任务必须属于所选项目的独立 worktree" });
    }
    if (!input.text.trim() && input.attachments.length === 0) {
      ctx.addIssue({ code: "custom", message: "请填写首消息或添加附件" });
    }
    if (/^\/(制定方案|复核方案|执行|复核|验证|通过|停止任务)(?:\s|$)/u.test(input.text.trim())) {
      ctx.addIssue({ code: "custom", message: "任务命令需要联网后在原生对话中操作" });
    }
  });

export const FirstMessageOutboxEntrySchema = FirstMessageOutboxInputSchema.safeExtend({
  requestId: z.string().min(1).max(512),
  clientMessageId: z.string().min(1),
  createdAt: z.number().finite(),
  status: z.enum(["queued", "sending", "unknown", "failed", "sent"]),
  submitted: z.boolean(),
  replayBlocked: z.boolean(),
  error: z.string().nullable(),
  result: z
    .object({
      workspaceId: z.string().min(1),
      agentId: z.string().min(1),
      conversationId: z.string().min(1).optional(),
      memberId: z.string().min(1).optional(),
    })
    .nullable(),
});

export const FirstMessageOutboxStorageSchema = z
  .object({
    version: z.literal(1),
    entries: z.array(FirstMessageOutboxEntrySchema),
  })
  .superRefine(({ entries }, ctx) => {
    const ids = new Set<string>();
    for (const entry of entries) {
      if (ids.has(entry.id)) ctx.addIssue({ code: "custom", message: "待发送项 ID 重复" });
      ids.add(entry.id);
      if (entry.status === "sent" && !entry.result) {
        ctx.addIssue({ code: "custom", message: "已发送项缺少正式会话回执" });
      }
    }
  });

export type FirstMessageOutboxInput = z.infer<typeof FirstMessageOutboxInputSchema>;
export type FirstMessageOutboxEntry = z.infer<typeof FirstMessageOutboxEntrySchema>;
