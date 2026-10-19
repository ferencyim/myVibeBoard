// Dispatch (WP-12): todo -> in_progress. Reads the card and its preset, creates the workspace
// (new worktree or the project directory), starts the worker agent and records the session
// through the shared command layer (`cards.dispatch`, the only todo -> in_progress entry).
//
// Admission (concurrency, quota, priority) belongs to vibe-scheduler (WP-34): it decides WHEN to
// call `dispatch(cardId)`; the optional `admit` gate lets an in-process scheduler veto a call.
// Without a gate the default is "dispatch immediately".

import { randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import type { AgentSession, CardView, Preset, Project } from "../vibe/contract";
import { BoardError, toBoardError, type BoardService } from "../service";
import { loadHandoff } from "./handoff";
import { buildDispatchBrief, modeIdFor, providerSpec, threadTitle, worktreeSlug } from "./brief";

export type DispatchPaseo = Pick<PaseoApi, "projects" | "workspaces">;

/** Hand-off to the lifecycle listener so events fired before the session row exists are not lost. */
export interface AgentTracker {
  expect(agentId: string): void;
  bind(agentId: string): Promise<void>;
  release(agentId: string): void;
}

export interface DispatchOptions {
  presetId?: string;
  extraInstructions?: string;
  /** Skip the admission gate (manual "dispatch now" from the UI). */
  force?: boolean;
}

export interface DispatchResult {
  card: CardView;
  session: AgentSession;
  workspaceId: string;
  agentId: string;
}

export interface DispatcherOptions {
  board: BoardService;
  /** Resolved per call: the SDK handle comes from the RPC/hook context. */
  getPaseo: () => DispatchPaseo | null;
  tracker?: AgentTracker;
  /** Scheduler gate; resolve false (or throw) to refuse. Default: always admit. */
  admit?: (card: CardView) => boolean | Promise<boolean>;
  newAgentId?: () => string;
}

const normalizePath = (p: string) => p.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();

export function createDispatcher(options: DispatcherOptions) {
  const { board, tracker } = options;
  const { store } = board;
  const inflight = new Set<string>();

  async function findPaseoProject(paseo: DispatchPaseo, project: Project) {
    const { projects } = await paseo.projects.list();
    const ref = project.paseoProjectId;
    const found = ref
      ? projects.find(
          (p) =>
            p.projectId === ref || p.projectRootPath === ref || p.projectDisplayName === ref,
        )
      : projects.find((p) => normalizePath(p.projectRootPath) === normalizePath(project.repoPath));
    if (!found) {
      throw new BoardError(
        "invalid",
        `Project ${project.prefix} is not linked to a Paseo project (repo ${project.repoPath || "unset"})`,
      );
    }
    return found;
  }

  function pickPreset(card: CardView, project: Project, presetId?: string): Preset {
    const id = presetId ?? card.presetId ?? project.defaultPresetId;
    if (!id) throw new BoardError("invalid", `${card.key} has no preset and the project has no default`);
    const preset = store.presets.list().find((p) => p.id === id || p.name === id);
    if (!preset) throw new BoardError("not_found", `Preset not found: ${id}`);
    return preset;
  }

  function recordFailure(card: CardView, error: unknown): never {
    const message = error instanceof Error ? error.message : String(error);
    store.events.add({
      cardId: card.id,
      type: "status",
      authorKind: "system",
      author: "dispatcher",
      body: { kind: "dispatch_failed", message },
    });
    throw error instanceof BoardError ? error : new BoardError("dispatch_failed", message);
  }

  async function dispatch(cardRef: string, opts: DispatchOptions = {}): Promise<DispatchResult> {
    const card = board.cards.get(cardRef);
    if (card.column !== "todo") {
      throw new BoardError("illegal_transition", `${card.key} is in "${card.column}"; only todo cards can be dispatched`);
    }
    if (inflight.has(card.id)) throw new BoardError("conflict", `${card.key} is already being dispatched`);
    inflight.add(card.id);
    let agentId: string | null = null;
    try {
      if (!opts.force && options.admit && !(await options.admit(card))) {
        throw new BoardError("not_admitted", `Scheduler did not admit ${card.key}`);
      }
      const paseo = options.getPaseo();
      if (!paseo) throw new BoardError("unavailable", "Dispatch needs an active Paseo daemon connection");
      const project = store.projects.get(card.projectId);
      if (!project) throw new BoardError("not_found", `Project not found: ${card.projectId}`);
      const preset = pickPreset(card, project, opts.presetId);

      let workspaceId = "";
      let worktree: string | null = null;
      try {
        const target = await findPaseoProject(paseo, project);
        const useWorktree = preset.environmentKind === "new-worktree" && target.projectKind === "git";
        const title = threadTitle(card);
        const workspace = await paseo.workspaces.create({
          title,
          source: useWorktree
            ? {
                kind: "worktree",
                cwd: target.projectRootPath,
                projectId: target.projectId,
                action: "branch-off",
                ...(preset.baseBranch ? { baseBranch: preset.baseBranch } : {}),
                worktreeSlug: worktreeSlug(card),
              }
            : { kind: "directory", path: target.projectRootPath, projectId: target.projectId },
        });
        const events = store.events.list(card.id);
        const prompt = buildDispatchBrief({
          card,
          project,
          preset,
          events,
          handoff: loadHandoff(project, card, events),
          latestPlan: store.plans.list(card.id).at(-1),
          extraInstructions: opts.extraInstructions,
        });
        const modeId = modeIdFor(preset.provider, preset.permissionMode);
        const id = (agentId = (options.newAgentId ?? randomUUID)());
        tracker?.expect(id);
        const env: Record<string, string> = {
          VIBE_ROLE: "worker",
          VIBE_CARD_ID: card.id,
          VIBE_CARD_KEY: card.key,
        };
        if (preset.runtimeEnv) env.VIBE_RUNTIME_ENV = preset.runtimeEnv;
        workspaceId = workspace.id;
        worktree = useWorktree ? workspace.directory : null;
        await workspace.agents.create({
          agentId: id,
          title,
          prompt,
          labels: { cardKey: card.key, cardId: card.id, role: "worker", preset: preset.name },
          env,
          config: {
            provider: providerSpec(preset),
            ...(preset.thinking && preset.thinking !== "default"
              ? { thinkingOptionId: preset.thinking }
              : {}),
            ...(modeId ? { modeId } : {}),
          },
        });
      } catch (error) {
        return recordFailure(card, error);
      }

      const result = store.cards.dispatch({
        cardId: card.id,
        agentId,
        workspaceId,
        provider: preset.provider,
        worktree,
        presetId: preset.id,
      });
      await tracker?.bind(agentId);
      return { ...result, workspaceId, agentId };
    } catch (error) {
      if (agentId) tracker?.release(agentId);
      throw toBoardError(error);
    } finally {
      inflight.delete(card.id);
    }
  }

  return { dispatch };
}

export type Dispatcher = ReturnType<typeof createDispatcher>;
