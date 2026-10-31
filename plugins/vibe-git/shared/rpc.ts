import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const counts = z.object({ ahead: z.number(), behind: z.number() });
const changes = z.object({
  staged: z.number(),
  unstaged: z.number(),
  untracked: z.number(),
  total: z.number(),
});
const worktree = z.object({
  path: z.string(),
  branch: z.string().nullable(),
  detached: z.boolean(),
  current: z.boolean(),
  counts: counts.nullable(),
  merged: z.boolean().nullable(),
  prunable: z.boolean(),
  missing: z.boolean(),
  changes: changes.nullable(),
  changesScannedAt: z.string().nullable().optional(),
});
const git = z.object({
  status: z.enum(["ok", "not_git", "error"]),
  error: z.string().nullable(),
  workspacePath: z.string(),
  mainPath: z.string().nullable(),
  branch: z.string().nullable(),
  headSha: z.string().nullable(),
  headSubject: z.string().nullable(),
  isMain: z.boolean(),
  upstream: z.string().nullable(),
  upstreamCounts: counts.nullable(),
  base: z.string().nullable(),
  baseCounts: counts.nullable(),
  changes: changes.nullable(),
  operation: z.string().nullable(),
  commits: z.array(z.object({ sha: z.string(), subject: z.string(), timestamp: z.number() })),
  worktrees: z.array(worktree),
  changesScannedAt: z.string().nullable().optional(),
  scanning: z.boolean().optional(),
  scanError: z.string().nullable().optional(),
});
const clientStatus = z.object({
  client: z.string(),
  buildStatus: z.string().nullable(),
  uploadStatus: z.string().nullable(),
  publishStatus: z.string().nullable(),
});
const pipeline = z.object({
  repo: z.string(),
  project: z.string().nullable(),
  status: z.string().nullable(),
  buildStatus: z.string().nullable(),
  failureReason: z.string().nullable(),
  clientStatuses: z.array(clientStatus),
  upload: z.string().nullable(),
  publish: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  sourceSha: z.string().nullable(),
  shaRelation: z.object({ status: z.enum(["same", "behind", "unknown"]), count: z.number().nullable() }),
});
const version = z.object({
  displayVersion: z.string().nullable(),
  build: z.string().nullable(),
  stateChangedAt: z.string().nullable(),
});
const item = z.object({
  targetKey: z.string(),
  platform: z.string(),
  channel: z.string(),
  released: version.nullable(),
  testing: version.nullable(),
  rollingOut: version.nullable(),
  unreleasedCommitCount: z.number().nullable(),
  lastGateFailure: z.string().nullable(),
  storeSubmission: z.string().nullable(),
});
const product = z.object({
  id: z.string(),
  name: z.string(),
  repo: z.string(),
  status: z.string(),
  stale: z.boolean(),
  fetchedAt: z.string().nullable(),
  items: z.array(item),
});
const sectionStatus = z.enum(["ok", "dashboard_down", "not_configured", "error"]);
export const StatusSchema = z.object({
  git,
  build: z.object({ status: sectionStatus, loading: z.boolean().optional(), pipelines: z.array(pipeline) }),
  release: z.object({ status: sectionStatus, loading: z.boolean().optional(), products: z.array(product) }),
});
export type Status = z.infer<typeof StatusSchema>;
export type Changes = z.infer<typeof changes>;
export const statusRpc = defineRpc({
  name: "git.status",
  input: z.object({ workspaceId: z.string().min(1), force: z.boolean().optional() }),
  output: StatusSchema,
});
