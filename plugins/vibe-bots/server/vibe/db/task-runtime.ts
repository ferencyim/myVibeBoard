// GENERATED FROM plugins/vibe-shared — DO NOT EDIT (run: node scripts/vibe/sync-shared.mjs)
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { SessionRoleSchema } from "../contract/enums";
import { EVENT_PAYLOADS } from "../contract/events";
import { AgentSessionSchema, type AgentSession } from "../contract/model";
import { publishEvent } from "./events";
import { decodeRow } from "./rows";
import type { VibeDb } from "./sqlite";

const RegisterSchema = z.object({
  workspaceId: z.string().min(1).nullable(),
  projectId: z.string().min(1).nullable().optional(),
  agentId: z.string().min(1),
  role: SessionRoleSchema,
  provider: z.string().min(1),
  model: z.string().min(1),
  thinking: z.string().optional(),
  candidateIndex: z.number().int().nonnegative(),
  previousSessionId: z.string().nullable().optional(),
  confirmedAt: z.string().nullable().optional(),
});
export type RegisterTaskSessionInput = z.infer<typeof RegisterSchema>;
export interface ContinueTaskSessionInput {
  fromSessionId: string;
  agentId: string;
  provider: string;
  model: string;
  thinking?: string;
  candidateIndex: number;
  reason: string;
}
export interface ResumeCompletedTaskSessionInput {
  workspaceId: string;
  agentId: string;
  role: RegisterTaskSessionInput["role"];
  confirmedAt: string | null;
}

/** Additive workspace/session commands; the legacy card session API remains unchanged. */
export function createTaskRuntimeCommands(db: VibeDb, options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  const decode = (row: Record<string, unknown> | undefined) =>
    row ? decodeRow(AgentSessionSchema, row) : undefined;
  const getSession = (sessionId: string) =>
    decode(db.prepare("SELECT * FROM agent_session WHERE id = ?").get(sessionId));
  const findSessionByAgent = (agentId: string) =>
    decode(db.prepare("SELECT * FROM agent_session WHERE agent_id = ?").get(agentId));
  const requireSession = (sessionId: string) => {
    const session = getSession(sessionId);
    if (!session) throw new Error("会话不存在：" + sessionId);
    return session;
  };
  const registerSession = (input: RegisterTaskSessionInput): AgentSession =>
    db.immediate(() => {
      const parsed = RegisterSchema.parse(input);
      const existing = findSessionByAgent(parsed.agentId);
      if (existing) {
        if (existing.workspaceId !== parsed.workspaceId || existing.role !== parsed.role)
          throw new Error("原生 agent 已关联其它 workspace 或角色");
        return existing;
      }
      const id = randomUUID();
      const ts = now().toISOString();
      db.prepare(
        "INSERT INTO agent_session (id,card_id,agent_id,workspace_id,role,current_provider,last_activity_at,started_at,project_id,model,thinking,candidate_index,previous_session_id,confirmed_at) VALUES (?,NULL,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        id,
        parsed.agentId,
        parsed.workspaceId,
        parsed.role,
        parsed.provider,
        ts,
        ts,
        parsed.projectId ?? null,
        parsed.model,
        parsed.thinking ?? null,
        parsed.candidateIndex,
        parsed.previousSessionId ?? null,
        parsed.confirmedAt ?? null,
      );
      publishEvent(
        db,
        {
          type: "session.started",
          projectId: parsed.projectId ?? null,
          payload: {
            sessionId: id,
            agentId: parsed.agentId,
            role: parsed.role,
            provider: parsed.provider,
          },
        },
        now,
      );
      return requireSession(id);
    });
  return {
    getSession,
    getContinuation: (fromSessionId: string) =>
      decode(
        db.prepare("SELECT * FROM agent_session WHERE previous_session_id = ?").get(fromSessionId),
      ),
    findSessionByAgent,
    registerSession,
    /** Host validates canonical membership and admits the new turn before calling this repair. */
    resumeCompletedSession(
      sessionId: string,
      input: ResumeCompletedTaskSessionInput,
    ): AgentSession {
      const parsed = z
        .object({
          workspaceId: z.string().min(1),
          agentId: z.string().min(1),
          role: SessionRoleSchema,
          confirmedAt: z.string().nullable(),
        })
        .strict()
        .parse(input);
      return db.immediate(() => {
        const session = requireSession(sessionId);
        if (
          session.cardId !== null ||
          session.workspaceId !== parsed.workspaceId ||
          session.agentId !== parsed.agentId ||
          session.role !== parsed.role
        )
          throw new Error("仅可恢复同一任务、原生 agent 和角色的正常完成会话");
        const task = db
          .prepare<{ confirmed_at: string | null }>(
            "SELECT confirmed_at FROM task WHERE workspace_id = ?",
          )
          .get(parsed.workspaceId);
        if (!task || task.confirmed_at !== parsed.confirmedAt)
          throw new Error("任务确认已变化，拒绝恢复旧运行");
        if (db.prepare("SELECT id FROM agent_session WHERE previous_session_id = ?").get(sessionId))
          throw new Error("会话已有接续替代者，不能恢复旧运行");
        const ended = db
          .prepare<{ payload_json: string }>(
            "SELECT payload_json FROM vibe_event WHERE type = 'session.ended' AND json_extract(payload_json, '$.sessionId') = ? ORDER BY seq DESC LIMIT 1",
          )
          .get(sessionId);
        const event = EVENT_PAYLOADS["session.ended"].safeParse(
          ended ? JSON.parse(ended.payload_json) : undefined,
        );
        if (
          !event.success ||
          event.data.agentId !== parsed.agentId ||
          event.data.outcome !== "completed"
        )
          throw new Error("缺少最后一次正常完成的会话结束证据，拒绝恢复");
        if (
          ["idle", "working"].includes(session.state) &&
          session.confirmedAt === parsed.confirmedAt
        )
          return session;
        if (session.state !== "ended" || !session.endedAt)
          throw new Error("仅可恢复已正常结束的叶子任务会话");
        const result = db
          .prepare(
            "UPDATE agent_session SET state = 'idle', ended_at = NULL, confirmed_at = ?, last_activity_at = ?, waiting_since = NULL, pending_question_json = NULL, stalled_since = NULL WHERE id = ? AND card_id IS NULL AND workspace_id = ? AND agent_id = ? AND role = ? AND state = 'ended' AND NOT EXISTS (SELECT 1 FROM agent_session replacement WHERE replacement.previous_session_id = agent_session.id)",
          )
          .run(
            parsed.confirmedAt,
            now().toISOString(),
            sessionId,
            parsed.workspaceId,
            parsed.agentId,
            parsed.role,
          );
        if (result.changes !== 1) throw new Error("会话状态已变化，请重新核对后恢复");
        publishEvent(
          db,
          {
            type: "task.updated",
            projectId: session.projectId ?? null,
            payload: { workspaceId: parsed.workspaceId, fields: ["sessions"] },
          },
          now,
        );
        return requireSession(sessionId);
      });
    },
    listSessions(filter: { workspaceId?: string; projectId?: string } = {}): AgentSession[] {
      let rows: Record<string, unknown>[];
      if (filter.workspaceId !== undefined) {
        rows = db
          .prepare("SELECT * FROM agent_session WHERE workspace_id = ? ORDER BY started_at,id")
          .all(filter.workspaceId);
      } else if (filter.projectId !== undefined) {
        rows = db
          .prepare("SELECT * FROM agent_session WHERE project_id = ? ORDER BY started_at,id")
          .all(filter.projectId);
      } else {
        rows = db
          .prepare("SELECT * FROM agent_session WHERE card_id IS NULL ORDER BY started_at,id")
          .all();
      }
      return rows.map((row) => decodeRow(AgentSessionSchema, row));
    },
    linkSession(
      sessionId: string,
      input: {
        workspaceId?: string | null;
        projectId?: string | null;
        confirmedAt?: string | null;
      },
    ): AgentSession {
      const parsed = z
        .object({
          workspaceId: z.string().min(1).nullable().optional(),
          projectId: z.string().min(1).nullable().optional(),
          confirmedAt: z.string().nullable().optional(),
        })
        .parse(input);
      return db.immediate(() => {
        const session = requireSession(sessionId);
        if (session.cardId !== null) throw new Error("旧卡片会话不能绑定为新任务");
        if (session.workspaceId && parsed.workspaceId && session.workspaceId !== parsed.workspaceId)
          throw new Error("会话不能改绑到其它 workspace");
        db.prepare(
          "UPDATE agent_session SET workspace_id = ?, project_id = ?, confirmed_at = ? WHERE id = ?",
        ).run(
          parsed.workspaceId === undefined ? session.workspaceId : parsed.workspaceId,
          parsed.projectId === undefined ? (session.projectId ?? null) : parsed.projectId,
          parsed.confirmedAt === undefined ? (session.confirmedAt ?? null) : parsed.confirmedAt,
          sessionId,
        );
        return requireSession(sessionId);
      });
    },
    getSelection(sessionId: string) {
      const session = getSession(sessionId);
      if (!session?.model || session.candidateIndex == null) return undefined;
      return {
        candidateIndex: session.candidateIndex,
        actualModel: {
          provider: session.currentProvider,
          model: session.model,
          ...(session.thinking ? { thinking: session.thinking } : {}),
        },
      };
    },
    recordContinuation(input: ContinueTaskSessionInput): { from: AgentSession; to: AgentSession } {
      return db.immediate(() => {
        const from = requireSession(input.fromSessionId);
        if (from.cardId !== null) throw new Error("旧卡片会话不能通过任务命令接续");
        const replacement = decode(
          db.prepare("SELECT * FROM agent_session WHERE previous_session_id = ?").get(from.id),
        );
        if (replacement) {
          if (replacement.agentId !== input.agentId)
            throw new Error("旧会话已由其它 agent 接续，请停止重复创建的 agent");
          return { from, to: replacement };
        }
        if (findSessionByAgent(input.agentId)) throw new Error("接续必须使用新的原生 agent");
        const to = registerSession({
          workspaceId: from.workspaceId,
          projectId: from.projectId,
          agentId: input.agentId,
          role: from.role,
          provider: input.provider,
          model: input.model,
          thinking: input.thinking,
          candidateIndex: input.candidateIndex,
          previousSessionId: from.id,
          confirmedAt: from.confirmedAt,
        });
        db.prepare(
          "UPDATE agent_session SET state = 'ended', ended_at = ?, waiting_since = NULL, pending_question_json = NULL, stalled_since = NULL WHERE id = ?",
        ).run(now().toISOString(), from.id);
        db.prepare("UPDATE agent_session SET reassigned_from_session_id = ? WHERE id = ?").run(
          from.id,
          to.id,
        );
        publishEvent(
          db,
          {
            type: "session.reassigned",
            projectId: from.projectId ?? null,
            payload: {
              sessionId: to.id,
              agentId: to.agentId,
              fromSessionId: from.id,
              fromAgentId: from.agentId,
              fromProvider: from.currentProvider,
              provider: to.currentProvider,
              reason: input.reason,
            },
          },
          now,
        );
        return { from: requireSession(from.id), to: requireSession(to.id) };
      });
    },
  };
}
export type TaskRuntimeCommands = ReturnType<typeof createTaskRuntimeCommands>;
