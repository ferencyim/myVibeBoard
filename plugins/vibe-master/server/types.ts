// Narrow structural views of the daemon handle and the plugin ports, so the logic is testable
// with hand-written fakes and the real PaseoApi stays assignable.

import type { PaseoApi } from "@getpaseo/client";

export interface RunResult {
  status: "idle" | "error" | "permission" | "timeout";
  lastMessage: string | null;
  error: string | null;
}

export interface MasterAgentHandle {
  readonly id: string;
  run(text: string, options?: { timeoutMs?: number; sourceAgentId?: string }): Promise<RunResult>;
  refresh(): Promise<unknown>;
  archive(): Promise<unknown>;
  /** Hosts older than v0.12.1 do not have it. */
  setTitle?(title: string): Promise<unknown>;
  /** Loads a closed agent back from its persisted session. Hosts older than the call do not have it. */
  resume?(): Promise<unknown>;
}

export interface ModelInfoLike {
  id: string;
  label: string;
  aliases?: string[];
  isSelectable?: boolean;
  isDefault?: boolean;
  thinkingOptions?: Array<{ id: string; label: string }>;
  defaultThinkingOptionId?: string;
}

export interface UsageProviderLike {
  providerId: string;
  displayName?: string;
  status?: string;
  windows: Array<{
    remainingPct?: number | null;
    usedPct?: number | null;
    resetsAt?: string | null;
  }>;
  error?: string | null;
}

export type CreateAgentOptions = Parameters<PaseoApi["agents"]["create"]>[0];

/** The slice of PaseoApi the master needs. */
export interface MasterPaseo {
  agents: {
    create(options: CreateAgentOptions): Promise<MasterAgentHandle>;
    ref(agentId: string): MasterAgentHandle;
  };
  workspaces?: {
    ref(workspaceId: string): {
      refresh(): Promise<{ projectId: string; workspaceDirectory: string | null } | null>;
    };
  };
  providers: {
    listModels(provider: string): Promise<{ models?: ModelInfoLike[]; error?: string | null }>;
    listUsage(): Promise<{ providers: UsageProviderLike[] }>;
    /** Optional like listModes: every provider Paseo knows (built in or from a plugin). */
    listAvailable?(): Promise<{ providers: Array<{ provider: string; available?: boolean }> }>;
    /** Optional so hand-written fakes stay small; the real PaseoApi always has it. */
    listModes?(
      provider: string,
    ): Promise<{ modes?: Array<{ id: string; label: string }>; error?: string | null }>;
  };
}

export type MasterErrorKind = "unavailable" | "quota" | "timeout" | "permission" | "agent";

export class MasterError extends Error {
  constructor(
    readonly kind: MasterErrorKind,
    message: string,
    readonly retryable?: boolean,
  ) {
    super(message);
    this.name = "MasterError";
  }
}

/** Asks the master a question and returns the raw reply text. */
export interface MasterAsk {
  ask(prompt: string, options?: { timeoutMs?: number }): Promise<string>;
}

/** WP-105: only memory consolidation is left; the master no longer reviews drafts or advises workers. */
export type WakeKind = "card_done" | "task_done";
export type WakeJob = (
  | { kind: "card_done"; cardId: string }
  | { kind: "task_done"; workspaceId: string }
) & { force?: boolean };
export const wakeTarget = (job: WakeJob) =>
  job.kind === "task_done" ? job.workspaceId : job.cardId;
export const jobKey = (job: WakeJob) => job.kind + ":" + wakeTarget(job);
