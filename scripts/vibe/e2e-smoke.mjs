// Integration smoke (WP-70) against an isolated dev daemon with all vibe plugins and the local codex.
// Server-side half of the flow; the phone steps (approve the waiting session, "pass" the card,
// offline edit) are done by hand / adb while this script waits and logs "PHONE:" prompts.
// Never part of `npm test`; costs a few small codex turns.
//
//   pwsh scripts/vibe/dev-daemon.ps1 -HomeDir <dir> -Port 16767   (then `plugin install` the 7 vibe-* plugins)
//   VIBE_E2E_CLIENT=<repo>/packages/client/dist/daemon-client.js VIBE_E2E_CLI=<repo>/packages/cli/dist/index.js \
//   VIBE_E2E_HOME=<dir> node scripts/vibe/e2e-smoke.mjs
//
// Env: VIBE_E2E_CLIENT, VIBE_E2E_CLI, VIBE_E2E_HOME (required); VIBE_E2E_PORT (16767),
// VIBE_E2E_PROVIDER (codex), SMOKE_STEP_TIMEOUT_MIN (10).

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const need = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const clientPath = need("VIBE_E2E_CLIENT");
const home = need("VIBE_E2E_HOME");
const port = process.env.VIBE_E2E_PORT || "16767";
const provider = process.env.VIBE_E2E_PROVIDER || "codex";
const stepTimeout = Number(process.env.SMOKE_STEP_TIMEOUT_MIN || 10) * 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const results = [];
const step = (name, ok, note = "") => {
  results.push({ name, ok, note });
  log(`STEP ${ok ? "OK  " : "FAIL"} ${name}${note ? " - " + note : ""}`);
};

const { DaemonClient } = await import(pathToFileURL(clientPath).href);
const client = new DaemonClient({
  url: `ws://127.0.0.1:${port}/ws`,
  clientId: "vibe-e2e-smoke",
  appVersion: "0.12.0",
});
await client.connect();
const board = (name, input) => client.invokePluginRpc("vibe-board", name, input);
const master = (name, input) => client.invokePluginRpc("vibe-master", name, input);
const verify = (name, input) => client.invokePluginRpc("vibe-verify", name, input);
const scheduler = (name, input) => client.invokePluginRpc("vibe-scheduler", name, input);

async function waitFor(what, fn, timeoutMs = stepTimeout) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await sleep(2500);
  }
}

// ---- project repo ----
const resumeRepo = process.env.SMOKE_REPO; // with SMOKE_RESUME_CARD: reuse the repository of the earlier run
const repo = resumeRepo || mkdtempSync(join(tmpdir(), "vibe-smoke-repo-"));
const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe", encoding: "utf8" });
if (!resumeRepo) {
  git("init", "-q", "-b", "main");
  git("config", "user.email", "smoke@example.invalid");
  git("config", "user.name", "smoke");
  writeFileSync(join(repo, "README.md"), "# smoke repo\n");
  writeFileSync(
    join(repo, "check.js"),
    [
      'const fs = require("fs");',
      'const t = fs.existsSync("hello.txt") ? fs.readFileSync("hello.txt", "utf8") : "";',
      'if (t !== "hello vibe\\n") { console.error("hello.txt wrong: " + JSON.stringify(t)); process.exit(1); }',
      'console.log("hello.txt ok");',
      "",
    ].join("\n"),
  );
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  await client.openProject(repo);
}
log("repo", repo);

const resume = process.env.SMOKE_RESUME_CARD; // card key (e.g. SMK-1) already in todo: continue at step 5b
let card;
try {
  if (resume) {
    card = (await board("vibe.cards.get", { card: resume })).card;
    log("resuming", card.key, card.column);
  } else {
    // 1. project + preset
    const status = await master("master.status", { includeProviders: true });
    const info = status.providers.find((p) => p.id === provider);
    if (!info) throw new Error(`provider ${provider} not available`);
    const model = info.models.find((m) => m.isDefault) ?? info.models[0];
    const thinking = model.thinking[0]?.id;
    await master("master.switch", { provider, model: model.id, thinking, reason: "smoke" });
    const { project } = await board("vibe.projects.create", {
      name: "Smoke",
      prefix: "SMK",
      repoPath: repo,
      projectType: "backend",
    });
    const { preset } = await board("vibe.presets.create", {
      name: "smoke-worker",
      provider,
      model: model.id,
      thinking: thinking ?? "default",
      permissionMode: "accept-edits",
      environmentKind: "new-worktree",
      baseBranch: null,
      runtimeEnv: null,
      instructions: "",
    });
    await board("vibe.projects.update", {
      project: project.id,
      defaultPresets: { worker: preset.id, verifier: preset.id },
    });
    step("1 project + preset created", true, `${project.prefix}, ${provider}/${model.id}`);

    // 2. draft card
    ({ card } = await board("vibe.cards.create", {
      project: project.prefix,
      title: "Add hello.txt",
      description:
        'Create hello.txt in the repository root containing exactly "hello vibe" and a newline. Then commit it with `git add hello.txt && git commit -m "add hello"`. `node check.js` must exit 0.',
      acceptance: "node check.js exits 0; hello.txt is committed",
      column: "draft",
      presetId: preset.id,
      needsEvidence: true,
    }));
    step("2 draft card created", card.column === "draft", card.key);

    // 3. master assesses the draft
    const assessed = await waitFor("master assessment", async () => {
      const d = await detail();
      return d.events.some((e) => e.type === "evaluation") && d.plans.length > 0 ? d : null;
    });
    const ev = assessed.events.find((e) => e.type === "evaluation");
    step(
      "3 master assessment comment + plan version",
      true,
      `plan v${assessed.plans.at(-1).version}, checks ${assessed.plans.at(-1).snapshot?.checks?.length ?? "?"}; ${String(
        ev.body?.text ?? "",
      )
        .slice(0, 80)
        .replace(/\s+/g, " ")}`,
    );

    // 4. one discussion round
    const sent = (
      await board("vibe.events.add", {
        card: card.id,
        type: "note",
        authorKind: "user",
        author: "user",
        body: {
          kind: "discussion",
          role: "user",
          text: "Keep it minimal: only hello.txt, commit it. Anything open? Answer briefly.",
        },
      })
    ).event;
    const reply = await waitFor("planner reply", async () =>
      (await detail()).events.find(
        (e) =>
          e.authorKind === "agent" &&
          Array.isArray(e.body?.answers) &&
          e.body.answers.includes(sent.id),
      ),
    );
    step(
      "4 draft discussion round answered by planner",
      !reply.body.error,
      String(reply.body.text).slice(0, 100).replace(/\s+/g, " "),
    );

    // 5. to todo, scheduler admits and dispatches
    await board("vibe.cards.move", { card: card.id, to: "todo", actor: "user" });
    step("5a card moved to todo", true);
  }
  const detail = () => board("vibe.cards.get", { card: card.id });
  if (process.env.SMOKE_DISPATCH_NOW) {
    await board("vibe.cards.dispatch", { card: card.id });
    log("dispatched directly (scheduler bypassed)");
  }
  const started = await waitFor("scheduler admission + dispatch", async () => {
    const d = await detail();
    return d.card.column === "in_progress" && d.sessions.some((s) => s.role === "worker")
      ? d
      : null;
  });
  const worker = started.sessions.find((s) => s.role === "worker");
  const sstat = await scheduler("scheduler.status", {});
  step(
    "5b scheduler admitted and card dispatched",
    true,
    `worker ${worker.agentId}, worktree ${started.card.worktree}; scheduler admitted=${JSON.stringify(sstat.admitted ?? sstat.running ?? null)}`,
  );

  // 6. waiting for approval (phone)
  const waiting = await waitFor("worker waiting for approval", async () => {
    const d = await detail();
    if (d.card.column === "verifying") return "skipped";
    return d.sessions.find((s) => s.role === "worker" && s.state === "waiting") ?? null;
  });
  if (waiting === "skipped") {
    step(
      "6 worker waited for approval",
      false,
      "worker never asked (card went straight to verifying)",
    );
  } else {
    log(
      "PHONE: worker waiting for approval ->",
      JSON.stringify(waiting.question ?? waiting.waitingFor ?? null),
    );
    step("6a worker session waiting", true, `agent ${waiting.agentId}`);
    await waitFor(
      "approval answered (phone)",
      async () => {
        const d = await detail();
        return d.sessions.find((s) => s.role === "worker" && s.state !== "waiting") ? true : null;
      },
      20 * 60_000,
    );
    step("6b approval answered (phone or fallback)", true);
  }

  // 7. verifying + evidence
  const verifying = await waitFor(
    "card in verifying",
    async () => {
      const d = await detail();
      return d.card.column === "verifying" ? d : null;
    },
    15 * 60_000,
  );
  step("7a worker finished, card in verifying", true);
  const ver = await waitFor(
    "verification result",
    async () => {
      const { detail: v } = await verify("vibe.verify.get", { card: card.id });
      return v && v.verification.conclusion ? v : null;
    },
    15 * 60_000,
  );
  step(
    "7b verification evidence bundle",
    ver.evidence.length > 0,
    `conclusion=${ver.verification.conclusion}, items ${ver.items.length}, evidence files ${ver.evidence.length}: ${ver.summary}`,
  );

  // 8. pass (phone) -> done -> merged + worktree removed
  log("PHONE: press Pass on the card now");
  await waitFor(
    "card done",
    async () => ((await detail()).card.column === "done" ? true : null),
    20 * 60_000,
  );
  step("8a card done (phone pass or fallback)", true);
  const finalized = await waitFor(
    "finalize",
    async () => {
      const d = await detail();
      return d.events.find(
        (e) =>
          e.body?.kind === "finalized" ||
          e.body?.kind === "finalize_pending" ||
          e.body?.kind === "finalize_blocked",
      );
    },
    3 * 60_000,
  );
  const merged = existsSync(join(repo, "hello.txt"));
  const wtList = git("worktree", "list");
  step(
    "8b merged into main and worktree removed",
    merged && wtList.trim().split("\n").length === 1,
    `${finalized.body?.kind}: ${String(finalized.body?.text).slice(0, 120)}; hello.txt on main=${merged}`,
  );
} catch (error) {
  step("ABORT", false, String(error?.message ?? error));
}

log(
  "SUMMARY\n" +
    results
      .map((r) => `${r.ok ? "OK  " : "FAIL"} ${r.name}${r.note ? " - " + r.note : ""}`)
      .join("\n"),
);
await client.close?.();
process.exit(results.every((r) => r.ok) ? 0 : 1);
