import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MasterSettings } from "../shared/rpc";
import { masterSettings } from "../shared/rpc";
import type { Clock } from "../server/clock";
import type {
  CreateAgentOptions,
  MasterAgentHandle,
  MasterPaseo,
  ModelInfoLike,
  RunResult,
  UsageProviderLike,
} from "../server/types";
import { createVibeStore, migrateOwner, openVibeDb } from "../server/vibe/db";

export function tempDir(prefix = "vibe-master-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Manual clock: timers only fire when the test advances time. */
export class ManualClock implements Clock {
  private t = 1_800_000_000_000;
  private timers: Array<{ at: number; fn: () => void; id: number }> = [];
  private seq = 0;
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.seq;
    this.timers.push({ at: this.t + ms, fn, id });
    return () => {
      this.timers = this.timers.filter((x) => x.id !== id);
    };
  };
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      const due = this.timers
        .filter((x) => x.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((x) => x !== due);
      this.t = due.at;
      due.fn();
    }
    this.t = target;
  }
}

export function setupBoard() {
  const db = openVibeDb({ path: ":memory:" });
  migrateOwner(db, "core");
  const store = createVibeStore(db);
  const repoPath = tempDir("vibe-master-repo-");
  const project = store.projects.create({
    name: "Demo",
    prefix: "DEMO",
    repoPath,
    projectType: "web",
  });
  const claude = store.presets.create({
    name: "Claude Opus",
    provider: "claude",
    model: "opus-x",
    thinking: "high",
  });
  const codex = store.presets.create({
    name: "Codex Max",
    provider: "codex",
    model: "gpt-5-codex",
    thinking: "xhigh",
  });
  const kimi = store.presets.create({
    name: "Kimi",
    provider: "kimi",
    model: "kimi-k2",
    thinking: "default",
  });
  const draft = (title: string, extra: Partial<Parameters<typeof store.cards.create>[0]> = {}) =>
    store.cards.create({
      projectId: project.id,
      title,
      description: `${title} description`,
      ...extra,
    });
  const eventTypes = () =>
    db
      .prepare<{ type: string }>("SELECT type FROM vibe_event ORDER BY seq")
      .all()
      .map((r) => r.type);
  return { db, store, project, repoPath, presets: { claude, codex, kimi }, draft, eventTypes };
}
export type Board = ReturnType<typeof setupBoard>;

/** Gets the master agent going (creates or reuses it) with a plain question. */
export async function askMaster(
  runtime: { session: { ask(prompt: string): Promise<string> } },
  prompt = "ping",
): Promise<string> {
  return runtime.session.ask(prompt);
}

export const MODELS: Record<string, ModelInfoLike[]> = {
  claude: [
    { id: "sonnet-x", label: "Sonnet X", isDefault: true },
    {
      id: "opus-x",
      label: "Opus X",
      thinkingOptions: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
    },
  ],
  codex: [
    {
      id: "gpt-5-codex",
      label: "GPT-5 Codex",
      isDefault: true,
      thinkingOptions: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
        { id: "xhigh", label: "Extra high" },
      ],
    },
  ],
};

/** Modes as the Paseo providers list them (claude: static list; codex: auto-review needs a new CLI). */
export const MODES: Record<string, Array<{ id: string; label: string }>> = {
  claude: [
    { id: "plan", label: "Plan Mode" },
    { id: "default", label: "Always Ask" },
    { id: "acceptEdits", label: "Accept File Edits" },
    { id: "auto", label: "Auto mode" },
    { id: "bypassPermissions", label: "Bypass" },
  ],
  codex: [
    { id: "auto", label: "Default Permissions" },
    { id: "auto-review", label: "Auto-review" },
    { id: "full-access", label: "Full Access" },
  ],
};

export type Script = (ctx: {
  provider: string;
  agentId: string;
  prompt: string;
  index: number;
}) => Promise<RunResult | string> | RunResult | string;

export interface FakeAgent {
  id: string;
  provider: string;
  options: CreateAgentOptions;
  prompts: string[];
  /** timeoutMs of every run() call, in order. */
  timeouts: Array<number | undefined>;
  sourceAgentIds: Array<string | undefined>;
  archived: boolean;
  /** The daemon stopped: the agent must be resumed before it takes a message. */
  closed?: boolean;
  resumes?: number;
  title?: string;
}

/** Hand-written PaseoApi stand-in: agents answer through `script`. */
export function fakePaseo(
  script: Script,
  options: {
    usage?: UsageProviderLike[];
    failCreate?: (provider: string) => string | null;
    modes?: Record<string, Array<{ id: string; label: string }>>;
    /** Simulates a host older than v0.12.1: handles have no setTitle. */
    noSetTitle?: boolean;
    /** Simulates a host without resume(). */
    noResume?: boolean;
    /** resume() rejects (the persisted session cannot be restored). */
    failResume?: boolean;
  } = {},
) {
  const agents: FakeAgent[] = [];
  let usage = options.usage ?? [];
  const handleFor = (agent: FakeAgent): MasterAgentHandle => ({
    id: agent.id,
    async run(text, runOptions) {
      agent.prompts.push(text);
      agent.timeouts.push((runOptions as { timeoutMs?: number } | undefined)?.timeoutMs);
      agent.sourceAgentIds.push(runOptions?.sourceAgentId);
      const out = await script({
        provider: agent.provider,
        agentId: agent.id,
        prompt: text,
        index: agent.prompts.length,
      });
      return typeof out === "string" ? { status: "idle", lastMessage: out, error: null } : out;
    },
    refresh: async () =>
      agent.archived ? null : { agent: { id: agent.id, status: agent.closed ? "closed" : "idle" } },
    archive: async () => {
      agent.archived = true;
      return { archivedAt: "now" };
    },
    ...(options.noResume
      ? {}
      : {
          resume: async () => {
            if (options.failResume) throw new Error("cannot restore");
            agent.closed = false;
            agent.resumes = (agent.resumes ?? 0) + 1;
          },
        }),
    ...(options.noSetTitle
      ? {}
      : {
          setTitle: async (title: string) => {
            agent.title = title;
          },
        }),
  });
  const paseo: MasterPaseo = {
    agents: {
      async create(opts) {
        const provider = String(opts.config.provider).split("/")[0]!;
        const failure = options.failCreate?.(provider);
        if (failure) throw new Error(failure);
        const agent: FakeAgent = {
          id: `agent-${agents.length + 1}`,
          provider,
          options: opts,
          prompts: [],
          timeouts: [],
          sourceAgentIds: [],
          archived: false,
        };
        agents.push(agent);
        return handleFor(agent);
      },
      ref: (id) => handleFor(agents.find((a) => a.id === id)!),
    },
    providers: {
      listModels: async (provider) => ({ models: MODELS[provider] ?? [] }),
      listUsage: async () => ({ providers: usage }),
      listModes: async (provider) => ({ modes: (options.modes ?? MODES)[provider] ?? [] }),
    },
  };
  return {
    paseo,
    agents,
    setUsage(next: UsageProviderLike[]) {
      usage = next;
    },
  };
}

/** The legacy `provider` setting stands in for a chosen preset (it resolves to the board's first preset of that provider). */
export const defaultSettings = (over: Partial<MasterSettings> = {}): MasterSettings => ({
  ...masterSettings.schema.parse({}),
  provider: "claude",
  ...over,
});

/** The owner picks another preset on the settings page: the legacy fields go, a running master moves over. */
export async function choosePreset(
  t: { settings: MasterSettings; runtime: { onSettingsChanged(): Promise<void> } },
  presetId: string,
): Promise<void> {
  t.settings.provider = "";
  t.settings.presetId = presetId;
  await t.runtime.onSettingsChanged();
}

export const usageOf = (providerId: string, remainingPct: number): UsageProviderLike => ({
  providerId,
  windows: [{ remainingPct }],
});

export function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

export const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
