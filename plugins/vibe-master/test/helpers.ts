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
import { createPermissionResolver } from "../server/subscription/permission";
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
      const due = this.timers.filter((x) => x.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
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
  const claude = store.presets.create({ name: "Claude Opus", provider: "claude", model: "opus", thinking: "high" });
  const codex = store.presets.create({ name: "Codex Max", provider: "codex", model: "gpt-5", thinking: "xhigh" });
  const kimi = store.presets.create({ name: "Kimi", provider: "kimi", model: "kimi-k2", thinking: "default" });
  const draft = (title: string, extra: Partial<Parameters<typeof store.cards.create>[0]> = {}) =>
    store.cards.create({ projectId: project.id, title, description: `${title} description`, ...extra });
  const eventTypes = () =>
    db.prepare<{ type: string }>("SELECT type FROM vibe_event ORDER BY seq").all().map((r) => r.type);
  return { db, store, project, repoPath, presets: { claude, codex, kimi }, draft, eventTypes };
}
export type Board = ReturnType<typeof setupBoard>;

export function assessmentJson(overrides: Record<string, unknown> = {}): string {
  const base = {
    clarity: { status: "clear", summary: "The request is clear.", questions: [] },
    related: [],
    split: { suggested: false, reason: "", subCards: [] },
    tags: ["feature"],
    estimate: { size: "M", rationale: "Touches two screens." },
    recommendation: { agent: "claude", preset: "Claude Opus", reason: "Needs strong reasoning." },
    risks: ["Layout may regress on small screens."],
    checks: [
      { text: "The new button is visible on the home screen", method: "screenshot" },
      { text: "Unit tests pass", method: "npm test" },
    ],
  };
  return `\`\`\`json\n${JSON.stringify({ ...base, ...overrides }, null, 2)}\n\`\`\``;
}

export const MODELS: Record<string, ModelInfoLike[]> = {
  claude: [
    { id: "sonnet-x", label: "Sonnet X", isDefault: true },
    { id: "opus-x", label: "Opus X", thinkingOptions: [{ id: "low", label: "Low" }, { id: "high", label: "High" }] },
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

export type Script = (ctx: { provider: string; agentId: string; prompt: string; index: number }) =>
  | Promise<RunResult | string>
  | RunResult
  | string;

export interface FakeAgent {
  id: string;
  provider: string;
  options: CreateAgentOptions;
  prompts: string[];
  archived: boolean;
}

/** Hand-written PaseoApi stand-in: agents answer through `script`. */
export function fakePaseo(
  script: Script,
  options: {
    usage?: UsageProviderLike[];
    failCreate?: (provider: string) => string | null;
    modes?: Record<string, Array<{ id: string; label: string }>>;
  } = {},
) {
  const agents: FakeAgent[] = [];
  let usage = options.usage ?? [];
  const handleFor = (agent: FakeAgent): MasterAgentHandle => ({
    id: agent.id,
    async run(text) {
      agent.prompts.push(text);
      const out = await script({
        provider: agent.provider,
        agentId: agent.id,
        prompt: text,
        index: agent.prompts.length,
      });
      return typeof out === "string" ? { status: "idle", lastMessage: out, error: null } : out;
    },
    refresh: async () => (agent.archived ? null : { agent: agent.id }),
    archive: async () => {
      agent.archived = true;
      return { archivedAt: "now" };
    },
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

/** The slice of the master session that planners use, with the permission mode of `fake`. */
export function fakeMaster(fake: ReturnType<typeof fakePaseo>, setting: () => string = () => "auto", provider = "claude") {
  const resolver = createPermissionResolver(() => fake.paseo);
  return {
    currentTarget: async () => ({ provider, model: "opus-x", thinking: null }),
    permission: async () => ({
      setting: setting(),
      source: "settings" as const,
      resolved: await resolver.resolve(provider, setting()),
    }),
  };
}

export const defaultSettings = (over: Partial<MasterSettings> = {}): MasterSettings => ({
  ...masterSettings.schema.parse({}),
  ...over,
});

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
