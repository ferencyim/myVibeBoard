// Real end-to-end run of the draft discussion flow (WP-33) against an isolated dev daemon with
// the local codex CLI: 3 discussion rounds -> hand-off -> todo -> dispatch -> the worker's first
// message contains the hand-off summary. Costs a few small codex turns; never run by `npm test`.
//
//   pwsh scripts/vibe/dev-daemon.ps1 -Plugin plugins/vibe-board,plugins/vibe-master -HomeDir <dir> -Port 16767 -Cli <cli>
//   VIBE_E2E_CLIENT=<repo>/packages/client/dist/daemon-client.js VIBE_E2E_CLI=<cli> VIBE_E2E_HOME=<dir> \
//     node plugins/vibe-master/scripts/e2e-planning.mjs
//   pwsh scripts/vibe/dev-daemon.ps1 -HomeDir <dir> -Stop -Cli <cli>
//
// Env: VIBE_E2E_CLIENT (built daemon-client.js), VIBE_E2E_CLI (built paseo CLI), VIBE_E2E_HOME
// (the dev-daemon HomeDir), VIBE_E2E_PORT (default 16767), VIBE_E2E_PROVIDER (default codex).

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const need = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const clientPath = need("VIBE_E2E_CLIENT");
const cli = need("VIBE_E2E_CLI");
const home = need("VIBE_E2E_HOME");
const port = process.env.VIBE_E2E_PORT || "16767";
const provider = process.env.VIBE_E2E_PROVIDER || "codex";
const paseoHome = join(home, "paseo");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const fail = (message) => {
  throw new Error(`E2E FAILED: ${message}`);
};

const { DaemonClient } = await import(pathToFileURL(clientPath).href);
const client = new DaemonClient({ url: `ws://127.0.0.1:${port}/ws`, clientId: "vibe-e2e-planning", appVersion: "0.12.0" });
await client.connect();
const board = (name, input) => client.invokePluginRpc("vibe-board", name, input);
const master = (name, input) => client.invokePluginRpc("vibe-master", name, input);

async function waitFor(what, fn, timeoutMs = 6 * 60_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) fail(`timeout waiting for ${what}`);
    await sleep(2500);
  }
}

// ---- project repo ----
const repo = mkdtempSync(join(tmpdir(), "vibe-e2e-repo-"));
const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
git("init", "-q", "-b", "main");
git("config", "user.email", "e2e@example.invalid");
git("config", "user.name", "e2e");
writeFileSync(join(repo, "README.md"), "# e2e repo\n");
git("add", "-A");
git("commit", "-q", "-m", "init");
await client.openProject(repo);
log("repo", repo);

// ---- master on the chosen provider (primes the master's daemon handle, too) ----
const status = await master("master.status", { includeProviders: true });
const info = status.providers.find((p) => p.id === provider);
if (!info) fail(`provider ${provider} is not available: ${status.providers.map((p) => p.id)}`);
const model = info.models.find((m) => m.isDefault) ?? info.models[0];
const thinking = model.thinking[0]?.id;
log("provider", provider, "model", model.id, "thinking", thinking);
await master("master.switch", { provider, model: model.id, thinking, reason: "e2e" });

// ---- board data ----
const { project } = await board("vibe.projects.create", {
  name: "E2E",
  prefix: "E2E",
  repoPath: repo,
  projectType: "other",
});
const { preset } = await board("vibe.presets.create", {
  name: "e2e-worker",
  provider,
  model: model.id,
  thinking: thinking ?? "default",
  permissionMode: "full",
  environmentKind: "project-default",
  baseBranch: null,
  runtimeEnv: null,
  instructions: "",
});
const { card } = await board("vibe.cards.create", {
  project: project.prefix,
  title: "Add hello.txt",
  description: "Create a file hello.txt in the repository root.",
  column: "draft",
  presetId: preset.id,
});
log("card", card.key);

const detail = () => board("vibe.cards.get", { card: card.id });
const say = async (body) =>
  (
    await board("vibe.events.add", {
      card: card.id,
      type: "note",
      authorKind: "user",
      author: "user",
      body,
    })
  ).event;
const answeredBy = (events, id) =>
  events.find(
    (e) =>
      e.authorKind === "agent" && Array.isArray(e.body?.answers) && e.body.answers.includes(id),
  );

// ---- three discussion rounds ----
const rounds = [
  "Create hello.txt in the repo root. Anything you need to know before we plan this? Keep your answer short.",
  'The file content must be exactly "hello vibe" followed by a newline, nothing else in the repo changes. Please write the plan (description and acceptance checks) now.',
  "Looks good. Anything still open? If not, mark the plan as ready.",
];
for (const [i, text] of rounds.entries()) {
  const sent = await say({ kind: "discussion", role: "user", text });
  const reply = await waitFor(`planner reply ${i + 1}`, async () => answeredBy((await detail()).events, sent.id));
  log(`round ${i + 1} planner:`, String(reply.body.text).slice(0, 160).replace(/\s+/g, " "), reply.body);
  if (reply.body.error) fail(`planner failed in round ${i + 1}: ${reply.body.text}`);
}
const afterRounds = await detail();
const planners = afterRounds.sessions.filter((s) => s.role === "planner");
if (planners.length !== 1) fail(`expected one planner session, got ${planners.length}`);
if (afterRounds.card.planSessionId !== planners[0].id) fail("card.plan_session_id is not the planner");
if (afterRounds.plans.length < 1) fail("no plan version was written after 3 rounds");
if (afterRounds.card.column !== "draft") fail("the planner moved the card");
log("plan versions", afterRounds.plans.map((p) => p.version), "checks", afterRounds.plans.at(-1).snapshot.checks.length);

// ---- hand-off, then the owner moves the card ----
const request = await say({ kind: "handoff_request" });
const handoff = await waitFor("hand-off summary", async () => answeredBy((await detail()).events, request.id));
const file = join(repo, ".vibe", "sessions", `${card.key}-plan.md`);
if (!existsSync(file)) fail(`hand-off file missing: ${file}`);
const summary = readFileSync(file, "utf8");
log("hand-off written", file, `${summary.length} chars`);
const ended = (await detail()).sessions.find((s) => s.id === planners[0].id);
if (ended.state !== "ended") fail(`planner session not archived (state ${ended.state})`);
await board("vibe.cards.move", { card: card.id, to: "todo", actor: "user" });
const { session } = await board("vibe.cards.dispatch", { card: card.id });
log("dispatched worker agent", session.agentId);

// ---- the worker's first message carries the summary ----
const marker = "Planning hand-off";
const firstMessage = await waitFor("worker first message", async () => {
  const out = execFileSync("node", [cli, "--home", paseoHome, "logs", session.agentId], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return out.includes(marker) ? out : null;
}, 90_000);
const firstLine = summary.split("\n").find((l) => l.trim()) ?? "";
if (!firstMessage.includes(firstLine.trim().slice(0, 40))) fail("worker prompt lacks the summary text");
log("worker prompt contains the hand-off summary");

// ---- cleanup: every agent of the isolated daemon ----
const agents = JSON.parse(
  execFileSync("node", [cli, "--home", paseoHome, "ls", "-a", "--json"], { encoding: "utf8" }),
);
for (const a of Array.isArray(agents) ? agents : (agents.agents ?? [])) {
  try {
    execFileSync("node", [cli, "--home", paseoHome, "delete", a.id ?? a.agentId], { stdio: "ignore" });
  } catch {
    // already gone
  }
}
await client.close?.();
log("E2E OK");
process.exit(0);
