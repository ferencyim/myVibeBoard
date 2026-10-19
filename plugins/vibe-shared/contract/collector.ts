// Evidence collector and Runner interfaces (consumed by WP-22 web/backend, WP-23 android,
// WP-46 ios/desktop). Everything that touches the outside world goes through a Runner so
// collectors are unit-testable with a fake one. Runtime-neutral: type declarations only.

import { z } from "zod";
import type { ProjectType } from "./enums";
import { EvidenceKindSchema, JudgementSchema } from "./enums";

// --- Runner: the single process-execution seam ---------------------------------------------

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Written to the child's stdin. */
  input?: string;
  signal?: AbortSignal;
}

export interface RunResult {
  /** null when killed by signal or timeout. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface Runner {
  run(command: string, args: readonly string[], options?: RunOptions): Promise<RunResult>;
}

// --- evidence --------------------------------------------------------------------------------

export const EvidenceArtifactSchema = z.object({
  kind: EvidenceKindSchema,
  /** Absolute path of the file on disk. */
  path: z.string(),
  thumbPath: z.string().optional(),
  mimeType: z.string().optional(),
  sha256: z.string().optional(),
  label: z.string().optional(),
  capturedAt: z.string(),
  commitHash: z.string(),
  simulated: z.boolean(),
});
export type EvidenceArtifact = z.infer<typeof EvidenceArtifactSchema>;

export const CollectResultSchema = z.object({
  artifacts: z.array(EvidenceArtifactSchema),
  /** Collector's own verdict for the check, if it can make one (e.g. tests passed). */
  judgement: JudgementSchema.optional(),
  notes: z.array(z.string()),
  /** True when a fallback path was used (e.g. no Maestro, adb only); must be stated in notes. */
  degraded: z.boolean(),
});
export type CollectResult = z.infer<typeof CollectResultSchema>;

export interface CheckItemRef {
  id: string;
  text: string;
  /** How the check should be verified (free text from the master's assessment). */
  method: string;
}

export interface CollectorContext {
  cardId: string;
  verificationId: string;
  projectType: ProjectType;
  /** Project repo root. */
  projectPath: string;
  /** Worktree the change lives in (what to build/run). */
  worktreePath: string;
  commitHash: string;
  /** Directory the collector must write all artifacts into. */
  outputDir: string;
  /** The check being verified; absent for card-wide collection (tests, lint, before/after shots). */
  check?: CheckItemRef;
  /** Device id leased for this run (emulator, board, ...), when the collector needs one. */
  deviceId?: string;
  runner: Runner;
  now(): Date;
  signal?: AbortSignal;
  log(message: string): void;
}

export interface CollectorAvailability {
  available: boolean;
  /** Why unavailable, or what will be degraded; copied into the evidence notes. */
  reason?: string;
  /** Available but only via a fallback path. */
  degraded?: boolean;
}

export interface EvidenceCollector {
  /** Stable id, e.g. "web", "backend", "android", "ios", "desktop". */
  readonly id: string;
  readonly projectTypes: readonly ProjectType[];
  /** Cheap capability probe (is adb/maestro/browser present?). Must not mutate anything. */
  detect(ctx: CollectorContext): Promise<CollectorAvailability>;
  collect(ctx: CollectorContext): Promise<CollectResult>;
  /** Always called after collect (success or failure): stop emulators, servers, free leases. */
  dispose?(ctx: CollectorContext): Promise<void>;
}

export interface CollectorRegistry {
  register(collector: EvidenceCollector): void;
  get(id: string): EvidenceCollector | undefined;
  forProjectType(type: ProjectType): EvidenceCollector[];
  list(): EvidenceCollector[];
}

export function createCollectorRegistry(): CollectorRegistry {
  const byId = new Map<string, EvidenceCollector>();
  return {
    register(collector) {
      if (byId.has(collector.id)) throw new Error(`Collector already registered: ${collector.id}`);
      byId.set(collector.id, collector);
    },
    get: (id) => byId.get(id),
    forProjectType: (type) => [...byId.values()].filter((c) => c.projectTypes.includes(type)),
    list: () => [...byId.values()],
  };
}

// --- scripted fake Runner for collector tests -------------------------------------------------

export interface RunCall {
  command: string;
  args: readonly string[];
  options?: RunOptions;
}

export interface ScriptedRunner extends Runner {
  readonly calls: RunCall[];
}

/**
 * Fake Runner: `script` returns the result for a call (or undefined for a default
 * successful empty result). Every call is recorded in `calls`.
 */
export function createScriptedRunner(
  script: (
    call: RunCall,
  ) => Partial<RunResult> | undefined | Promise<Partial<RunResult> | undefined>,
): ScriptedRunner {
  const calls: RunCall[] = [];
  return {
    calls,
    async run(command, args, options) {
      const call: RunCall = { command, args, options };
      calls.push(call);
      const partial = (await script(call)) ?? {};
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0, ...partial };
    },
  };
}
