import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
export const briefPathSchema = z.enum(["AGENTS.md", "CLAUDE.md"]);
export const documentSchema = z.object({
  path: z.string(),
  content: z.string(),
  totalBytes: z.number(),
  truncated: z.boolean(),
  revision: z.string(),
  syncedAt: z.string(),
});
export const briefEditSchema = z.object({
  path: briefPathSchema,
  content: z.string().max(262144),
  baseRevision: z.string(),
});
export const pendingBriefSchema = z.object({
  id: z.string(),
  documents: z.array(briefEditSchema),
  createdAt: z.string(),
  deliveredAt: z.string().nullable(),
});
export const projectDocumentSnapshotSchema = z.object({
  documents: z.array(documentSchema),
  pending: z.array(pendingBriefSchema),
});
export type ProjectDocumentSnapshot = z.infer<typeof projectDocumentSnapshotSchema>;
export type BriefEdit = z.infer<typeof briefEditSchema>;
export const projectDocumentsGetRpc = defineRpc({
  name: "vibe.project.documents.get",
  input: z.object({ projectId: z.string().min(1) }),
  output: projectDocumentSnapshotSchema,
});
export const projectBriefSubmitRpc = defineRpc({
  name: "vibe.project.brief.submit",
  input: z.object({
    projectId: z.string().min(1),
    id: z.string().min(1),
    documents: z.array(briefEditSchema).min(1).max(2),
  }),
  output: projectDocumentSnapshotSchema,
});
