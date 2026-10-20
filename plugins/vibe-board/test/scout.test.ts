import { describe, expect, it } from "vitest";
import { callMcpTool, MCP_TOOLS, toolsForRole } from "../server/mcp/tools";
import { createScoutService, pickScoutPreset, readOnlyConfigFor, trimSummary, type ScoutConfig } from "../server/scout";
import { setupBoard } from "./helpers";

function setup(
  config: Partial<ScoutConfig> = {},
  env: { platform?: string; modes?: Record<string, string[]>; extraPresets?: Array<[string, string, string]> } = {},
) {
  const ctx = setupBoard();
  ctx.board.projects.create({ name: "Demo", prefix: "DEMO", repoPath: "/tmp/demo", projectType: "web" });
  const cheap = ctx.board.presets.create({ name: "Cheap", provider: "codex", model: "gpt-5-mini" }).preset;
  ctx.board.presets.create({ name: "Big", provider: "claude", model: "opus" });
  for (const [name, provider, model] of env.extraPresets ?? []) ctx.board.presets.create({ name, provider, model });
  const { card } = ctx.board.cards.create({ project: "DEMO", title: "A" });

  const created: any[] = [];
  let running = 0;
  let peak = 0;
  const behaviour = { delayMs: 20, hang: new Set<string>() };
  const paseo = {
    providers: {
      listModes: async (provider: string) => ({
        modes: (env.modes?.[provider] ?? []).map((id) => ({ id, label: id })),
      }),
    },
    agents: {
      create: async (opts: any) => {
        created.push(opts);
        let goal = "";
        return {
          run: async (prompt: string, o: { timeoutMs: number }) => {
            goal = /Goal: (.*)/.exec(prompt)?.[1] ?? "";
            running++;
            peak = Math.max(peak, running);
            try {
              if (behaviour.hang.has(goal)) {
                await new Promise((r) => setTimeout(r, o.timeoutMs));
                return { status: "timeout", lastMessage: "partial" };
              }
              await new Promise((r) => setTimeout(r, behaviour.delayMs));
              return { status: "idle", lastMessage: `src/a.ts:1 - ${goal}\n` };
            } finally {
              running--;
            }
          },
          archive: async () => void (opts.archived = true),
        };
      },
    },
  } as any;
  const published: string[] = [];
  const scout = createScoutService({
    board: ctx.board,
    getPaseo: () => paseo,
    getConfig: () => ({ preset: "", maxParallel: 4, timeoutMs: 1000, ...config }),
    publish: (type) => void published.push(type),
    headOf: async () => "head1",
    platform: env.platform ?? "linux",
  });
  return { ...ctx, paseo, card, cheap, scout, created, published, behaviour, peak: () => peak };
}

const tasks = (n: number) => Array.from({ length: n }, (_, i) => ({ goal: `goal ${i}` }));

describe("scout service", () => {
  it("runs scouts read-only with role=scout, archives them and records events", async () => {
    const t = setup();
    const out = await t.scout.run(t.card.key, tasks(3));
    expect(out.results.map((r) => r.status)).toEqual(["ok", "ok", "ok"]);
    expect(out.results[0]!.summary).toContain("src/a.ts:1");
    expect(t.created).toHaveLength(3);
    expect(t.created[0]).toMatchObject({
      labels: { role: "scout", cardKey: "DEMO-1" },
      env: { VIBE_ROLE: "scout" },
      config: {
        provider: "codex/gpt-5-mini",
        options: { sandbox_mode: "read-only", approval_policy: "never" },
      },
    });
    expect(t.created.every((c) => c.archived)).toBe(true);
    expect(t.published).toEqual(["scout.started", "scout.finished"]);
    const note = t.board.events.list(t.card.key).events.at(-1)!;
    expect(JSON.stringify(note.body)).toContain("3/3 ok");
  });

  it("on Windows prefers a provider with a real read-only mode (claude plan)", async () => {
    const t = setup({}, { platform: "win32" });
    const out = await t.scout.run(t.card.key, tasks(1));
    expect(out.preset).toBe("Big");
    expect(t.created[0].config).toMatchObject({ provider: "claude/opus", modeId: "plan" });
    expect(t.published).toEqual(["scout.started", "scout.finished"]);
    expect(JSON.stringify(t.board.events.list(t.card.key).events.at(-1)!.body)).not.toContain("NOT strictly");
  });

  it("on Windows without a strict provider falls back to codex full-access and says so", async () => {
    const t = setup({}, { platform: "win32" });
    for (const preset of t.board.presets.list().presets) {
      if (preset.name === "Big") t.board.presets.delete(preset.id);
    }
    await t.scout.run(t.card.key, tasks(1));
    expect(t.created[0].config).toMatchObject({ provider: "codex/gpt-5-mini", modeId: "full-access" });
    const body = JSON.stringify(t.board.events.list(t.card.key).events.at(-1)!.body);
    expect(body).toContain("NOT strictly read-only");
    expect(body).toContain("\"strictReadOnly\":false");
  });

  it("on Windows finds other providers whose listModes offer plan/read-only; an explicit setting wins", async () => {
    const t = setup({}, { platform: "win32", modes: { kimi: ["default", "plan"] }, extraPresets: [["Kimi", "kimi", "k2"]] });
    for (const preset of t.board.presets.list().presets) {
      if (preset.name === "Big") t.board.presets.delete(preset.id);
    }
    await t.scout.run(t.card.key, tasks(1));
    expect(t.created[0].config).toMatchObject({ provider: "kimi/k2", modeId: "plan" });
    const forced = setup({ preset: "Cheap" }, { platform: "win32" });
    await forced.scout.run(forced.card.key, tasks(1));
    expect(forced.created[0].config).toMatchObject({ provider: "codex/gpt-5-mini", modeId: "full-access" });
  });

  it("completes a model-less preset from the provider catalog and notes it", async () => {
    const withCatalog = setup();
    withCatalog.board.store.presets.update(withCatalog.cheap.id, { model: "" });
    (withCatalog.paseo as any).providers.listModels = async () => ({ models: [{ id: "gpt-5-mini", isDefault: true }] });
    await withCatalog.scout.run(withCatalog.card.key, tasks(1));
    expect(withCatalog.created[0].config.provider).toBe("codex/gpt-5-mini");
    expect(JSON.stringify(withCatalog.board.events.list(withCatalog.card.key).events.at(-1)!.body)).toContain("has no model");
  });

  it("honours the parallel cap", async () => {
    const t = setup({ maxParallel: 2 });
    await t.scout.run(t.card.key, tasks(6));
    expect(t.peak()).toBe(2);
    const wide = setup({ maxParallel: 99 });
    await wide.scout.run(wide.card.key, tasks(16));
    expect(wide.peak()).toBeLessThanOrEqual(16);
    expect(wide.peak()).toBeGreaterThan(4);
  });

  it("returns partial results when one scout times out", async () => {
    const t = setup({ timeoutMs: 50 });
    t.behaviour.hang.add("goal 1");
    const out = await t.scout.run(t.card.key, tasks(3));
    expect(out.results.map((r) => r.status)).toEqual(["ok", "timeout", "ok"]);
    expect(out.results[1]!.summary).toBe("partial");
  });

  it("caches the same goal for the same card and HEAD, but not failures", async () => {
    const t = setup();
    await t.scout.run(t.card.key, tasks(2));
    const again = await t.scout.run(t.card.key, [{ goal: "goal 0" }, { goal: "goal 9" }]);
    expect(again.results.map((r) => !!r.cached)).toEqual([true, false]);
    expect(t.created).toHaveLength(3);
  });

  it("rejects empty or oversized task lists", async () => {
    const t = setup();
    await expect(t.scout.run(t.card.key, [])).rejects.toThrow();
    await expect(t.scout.run(t.card.key, tasks(17))).rejects.toThrow();
  });
});

describe("scout preset selection", () => {
  it("prefers the setting, then role_hint=scout, then the cheapest", () => {
    const t = setup();
    const presets = t.board.presets.list().presets;
    expect(pickScoutPreset(presets, "Big")!.name).toBe("Big");
    expect(pickScoutPreset(presets, "")!.name).toBe("Cheap");
    const big = presets.find((p) => p.name === "Big")!;
    const hinted = presets.map((p) => (p.id === big.id ? { ...p, roleHint: "scout" } : p));
    expect(pickScoutPreset(hinted, "")!.name).toBe("Big");
    expect(pickScoutPreset(hinted, "missing")!.name).toBe("Big");
    expect(pickScoutPreset([], "")).toBeNull();
  });

  it("maps provider read-only modes and trims long summaries", () => {
    expect(readOnlyConfigFor("claude")).toEqual({ modeId: "plan" });
    expect(readOnlyConfigFor("codex", "linux").options).toMatchObject({ sandbox_mode: "read-only" });
    expect(readOnlyConfigFor("codex", "win32")).toEqual({ modeId: "full-access" });
    expect(readOnlyConfigFor("kimi")).toEqual({});
    const long = Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n");
    expect(trimSummary(long).split("\n")).toHaveLength(21);
  });
});

describe("vibe_scout MCP tool", () => {
  it("is hidden from verifiers, reviewers and scouts but visible to workers and unknown callers", () => {
    expect(MCP_TOOLS.some((t) => t.name === "vibe_scout")).toBe(true);
    for (const role of ["verifier", "reviewer", "scout"]) {
      expect(toolsForRole(role).some((t) => t.name === "vibe_scout")).toBe(false);
    }
    for (const role of ["worker", "master", undefined]) {
      expect(toolsForRole(role).some((t) => t.name === "vibe_scout")).toBe(true);
    }
  });

  it("runs through callMcpTool and refuses hidden roles", async () => {
    const t = setup();
    const ok = await callMcpTool("vibe_scout", { key: t.card.key, tasks: tasks(2) }, t.board, { role: "worker" }, t.scout);
    expect(JSON.parse(ok.content[0]!.text).results).toHaveLength(2);
    const denied = await callMcpTool("vibe_scout", { key: t.card.key, tasks: tasks(1) }, t.board, { role: "verifier" }, t.scout);
    expect(denied.isError).toBe(true);
  });
});
