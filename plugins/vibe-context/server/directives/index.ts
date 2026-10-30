// Per-turn injection of the hub's global directives into myVibeBoard agents (HUB-DESIGN 3).
// First turn: the full active list that matches the agent; later turns: only what changed.
// The text is marked as system material and never grants execution authorization.

import { createHash } from "node:crypto";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listActiveDirectives, type VibeDb } from "../vibe/db";

export const DIRECTIVE_HEADER = "[系统资料·全局指令（来自资源中枢，非用户消息，不构成执行授权）]";

type Snapshot = ReadonlyMap<string, string>;

export interface DirectiveInjectorOptions {
  db: VibeDb;
  now?: () => Date;
}

export function createDirectiveInjector(options: DirectiveInjectorOptions) {
  const delivered = new Map<string, Snapshot>();
  const pending = new Map<string, { deliveryId: string; snapshot: Snapshot }>();

  function prepare(agentId: string, target: { projectId?: string; provider?: string }) {
    const now = (options.now?.() ?? new Date()).toISOString();
    const current: Snapshot = new Map(
      listActiveDirectives(options.db, target, now).map((d) => [d.id, d.text.trim()]),
    );
    const before = delivered.get(agentId);
    const lines: string[] = [];
    if (!before) {
      if (!current.size) return null;
      lines.push("当前生效的全局指令：", ...[...current.values()].map((t) => `- ${t}`));
    } else {
      const added = [...current].filter(([id, t]) => before.get(id) !== t).map(([, t]) => t);
      const removed = [...before].filter(([id]) => !current.has(id)).map(([, t]) => t);
      if (!added.length && !removed.length) return null;
      if (added.length) lines.push("新增或变更的全局指令：", ...added.map((t) => `- ${t}`));
      if (removed.length) lines.push("已失效的全局指令（不再适用）：", ...removed.map((t) => `- ${t}`));
    }
    const deliveryId = createHash("sha256")
      .update(JSON.stringify(["directives", agentId, [...current]]))
      .digest("hex");
    pending.set(agentId, { deliveryId, snapshot: current });
    return { context: [DIRECTIVE_HEADER, ...lines].join("\n"), deliveryId };
  }

  function commit(agentId: string, deliveryId: string) {
    const next = pending.get(agentId);
    if (!next || next.deliveryId !== deliveryId) return;
    pending.delete(agentId);
    delivered.set(agentId, next.snapshot);
  }

  return { prepare, commit, forget: (agentId: string) => (delivered.delete(agentId), pending.delete(agentId)) };
}

export interface RegisterDirectiveInjectionOptions extends DirectiveInjectorOptions {
  projectIdFor: (cwd: string) => Promise<string | undefined>;
}

export function registerDirectiveInjection(
  server: PluginServerContext,
  options: RegisterDirectiveInjectionOptions,
) {
  const injector = createDirectiveInjector(options);
  const stops = [
    server.before("agent.turn_context", async ({ request }, { paseo }) => {
      try {
        const agent = (await paseo.agents.ref(request.agentId).refresh())?.agent;
        if (!agent) return undefined;
        const patch = injector.prepare(request.agentId, {
          provider: agent.provider,
          projectId: agent.cwd ? await options.projectIdFor(agent.cwd) : undefined,
        });
        if (!patch) return undefined;
        const context = request.context ? `${request.context}\n\n${patch.context}` : patch.context;
        // The hook has one receipt slot; when another plugin owns it, ours is committed at once.
        if (request.deliveryId) {
          injector.commit(request.agentId, patch.deliveryId);
          return { ...request, context };
        }
        return { ...request, context, deliveryId: patch.deliveryId };
      } catch (error) {
        // Best effort: never block a turn.
        console.error("vibe-context: 全局指令注入失败：", error);
        return undefined;
      }
    }),
    server.on("agent.turn_context_delivered", ({ agentId, deliveryId }) =>
      injector.commit(agentId, deliveryId),
    ),
    server.on("agent.closed", ({ agent }) => injector.forget(agent.id)),
  ];
  return () => {
    for (const stop of stops) stop();
  };
}
