// GENERATED FROM plugins/vibe-shared — DO NOT EDIT (run: node scripts/vibe/sync-shared.mjs)
// Global directives (hub_directive, owned by the scheduler migrations). Row access only: the
// issue/confirm/revoke rules live in vibe-scheduler, the per-turn injection reads active rows
// through listActiveDirectives in vibe-context.

import type { VibeDb } from "./sqlite";

export type DirectiveScope =
  | { kind: "all" }
  | { kind: "projects"; projectIds: string[] }
  | { kind: "providers"; providers: string[] };
export type DirectiveKind = "temporary" | "standing";
export type DirectiveStatus = "active" | "pending" | "revoked" | "expired";
export type DirectiveIssuer = "user" | "bot";
export interface DirectivePause {
  scope: string;
  until: string;
}

export interface Directive {
  id: string;
  text: string;
  scope: DirectiveScope;
  kind: DirectiveKind;
  expiresAt: string | null;
  issuedBy: DirectiveIssuer;
  status: DirectiveStatus;
  pause: DirectivePause | null;
  pauseId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DirectiveRow {
  id: string;
  text: string;
  scope_json: string;
  kind: DirectiveKind;
  expires_at: string | null;
  issued_by: DirectiveIssuer;
  status: DirectiveStatus;
  pause_json: string | null;
  pause_id: string | null;
  created_at: string;
  updated_at: string;
}

function toDirective(row: DirectiveRow): Directive {
  return {
    id: row.id,
    text: row.text,
    scope: JSON.parse(row.scope_json) as DirectiveScope,
    kind: row.kind,
    expiresAt: row.expires_at,
    issuedBy: row.issued_by,
    status: row.status,
    pause: row.pause_json ? (JSON.parse(row.pause_json) as DirectivePause) : null,
    pauseId: row.pause_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Who a directive applies to: a project id and/or provider id (`claude`, `codex/...`). */
export interface DirectiveTarget {
  projectId?: string;
  provider?: string;
}

export function directiveApplies(scope: DirectiveScope, target: DirectiveTarget): boolean {
  if (scope.kind === "all") return true;
  if (scope.kind === "projects") return !!target.projectId && scope.projectIds.includes(target.projectId);
  const provider = target.provider?.split("/")[0]?.toLowerCase();
  return !!provider && scope.providers.some((p) => p.toLowerCase() === provider);
}

export function createDirectiveRows(db: VibeDb) {
  const byId = (id: string) => {
    const row = db.prepare<DirectiveRow>("SELECT * FROM hub_directive WHERE id = ?").get(id);
    return row ? toDirective(row) : undefined;
  };
  return {
    get: byId,
    insert(d: Directive): void {
      db.immediate(() =>
        db
          .prepare(
            `INSERT INTO hub_directive (id,text,scope_json,kind,expires_at,issued_by,status,pause_json,pause_id,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            d.id,
            d.text,
            JSON.stringify(d.scope),
            d.kind,
            d.expiresAt,
            d.issuedBy,
            d.status,
            d.pause ? JSON.stringify(d.pause) : null,
            d.pauseId,
            d.createdAt,
            d.updatedAt,
          ),
      );
    },
    /** Status change guarded by the expected current status; returns whether a row changed. */
    transition(
      id: string,
      from: DirectiveStatus[],
      to: DirectiveStatus,
      now: string,
      pauseId?: string | null,
    ): boolean {
      return db.immediate(
        () =>
          db
            .prepare(
              `UPDATE hub_directive SET status = ?, updated_at = ?, pause_id = COALESCE(?, pause_id)
               WHERE id = ? AND status IN (${from.map(() => "?").join(",")})`,
            )
            .run(to, now, pauseId ?? null, id, ...from).changes > 0,
      );
    },
    list(status?: DirectiveStatus): Directive[] {
      const rows = status
        ? db
            .prepare<DirectiveRow>("SELECT * FROM hub_directive WHERE status = ? ORDER BY created_at, id")
            .all(status)
        : db.prepare<DirectiveRow>("SELECT * FROM hub_directive ORDER BY created_at, id").all();
      return rows.map(toDirective);
    },
    /** Active rows whose expiry has passed. */
    due(nowIso: string): Directive[] {
      return db
        .prepare<DirectiveRow>(
          "SELECT * FROM hub_directive WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ? ORDER BY created_at, id",
        )
        .all(nowIso)
        .map(toDirective);
    },
  };
}
export type DirectiveRows = ReturnType<typeof createDirectiveRows>;

/** Active directives that apply to `target`; [] when the table does not exist yet. */
export function listActiveDirectives(db: VibeDb, target: DirectiveTarget, nowIso: string): Directive[] {
  try {
    return createDirectiveRows(db)
      .list("active")
      .filter((d) => (!d.expiresAt || d.expiresAt > nowIso) && directiveApplies(d.scope, target));
  } catch {
    return [];
  }
}
