// Global directives (HUB-DESIGN 3): who may issue what, expiry, and the pause side effect.

import { newId } from "./vibe/contract";
import {
  createDirectiveRows,
  type Directive,
  type DirectiveIssuer,
  type DirectiveKind,
  type DirectivePause,
  type DirectiveScope,
  type DirectiveStatus,
  type VibeDb,
} from "./vibe/db";

export const BOT_TEMPORARY_MAX_MS = 24 * 60 * 60 * 1000;

/** WP-170 provides the real implementation (`hub.pause.create`); injected so this stays decoupled. */
export interface PauseGateway {
  create(input: {
    scope: string;
    until: string;
    reason: string;
    issuedBy: DirectiveIssuer;
    directiveId: string;
  }): Promise<{ id: string } | void> | { id: string } | void;
  remove?(id: string): Promise<void> | void;
}

export interface IssueInput {
  text: string;
  scope?: DirectiveScope;
  kind: DirectiveKind;
  expiresAt?: string | null;
  issuedBy: DirectiveIssuer;
  /** Optional pause rule enforced by the hub while the directive is active. */
  pause?: { scope: string; until?: string };
}

export interface DirectiveServiceOptions {
  db: VibeDb;
  now?: () => Date;
  pause?: PauseGateway;
  /** Tell the user about a bot-issued directive that took effect immediately. */
  notifyUser?: (directive: Directive) => void;
  /** Called after any change to the active set (file sync, injection refresh). */
  onChange?: () => void;
}

export function createDirectiveService(options: DirectiveServiceOptions) {
  const rows = createDirectiveRows(options.db);
  const now = () => options.now?.() ?? new Date();
  const changed = () => {
    try {
      options.onChange?.();
    } catch (error) {
      console.error("vibe-scheduler: 指令变更回调失败：", error);
    }
  };

  async function activate(id: string): Promise<Directive> {
    if (!rows.transition(id, ["pending"], "active", now().toISOString()))
      throw new Error("指令状态已变化，无法生效");
    const d = rows.get(id) as Directive;
    if (!d.pause || !options.pause) return d;
    try {
      const created = await options.pause.create({
        scope: d.pause.scope,
        until: d.pause.until,
        reason: d.text,
        issuedBy: d.issuedBy,
        directiveId: d.id,
      });
      if (created?.id) rows.transition(id, ["active"], "active", now().toISOString(), created.id);
    } catch (error) {
      rows.transition(id, ["active"], "revoked", now().toISOString());
      changed();
      throw new Error(`暂停规则创建失败，指令未生效：${String(error)}`);
    }
    return rows.get(id) as Directive;
  }

  return {
    async issue(input: IssueInput): Promise<Directive> {
      const text = input.text.trim();
      if (!text) throw new Error("指令内容不能为空");
      if (text.length > 4000) throw new Error("指令内容过长（上限 4000 字）");
      const at = now();
      const expiresAt = input.expiresAt ?? null;
      if (expiresAt !== null && !Number.isFinite(Date.parse(expiresAt)))
        throw new Error("有效期格式无效");
      if (input.kind === "temporary") {
        if (!expiresAt) throw new Error("临时指令必须设置有效期");
        if (Date.parse(expiresAt) <= at.getTime()) throw new Error("有效期必须晚于当前时间");
      }
      const bot = input.issuedBy === "bot";
      if (
        bot &&
        input.kind === "temporary" &&
        Date.parse(expiresAt as string) - at.getTime() > BOT_TEMPORARY_MAX_MS
      )
        throw new Error(
          "bot 只能下发有效期不超过 24 小时的临时指令；长期规则请改为 standing，由用户确认",
        );
      let pause: DirectivePause | null = null;
      if (input.pause) {
        const until = input.pause.until ?? expiresAt;
        if (!input.pause.scope.trim() || !until || !Number.isFinite(Date.parse(until)))
          throw new Error("暂停规则需要范围和结束时间");
        if (bot && Date.parse(until) - at.getTime() > BOT_TEMPORARY_MAX_MS)
          throw new Error("bot 下发的暂停不能超过 24 小时");
        pause = { scope: input.pause.scope.trim(), until };
      }
      const directive: Directive = {
        id: newId(at.getTime()),
        text,
        scope: input.scope ?? { kind: "all" },
        kind: input.kind,
        expiresAt,
        issuedBy: input.issuedBy,
        status: "pending",
        pause,
        pauseId: null,
        createdAt: at.toISOString(),
        updatedAt: at.toISOString(),
      };
      rows.insert(directive);
      // Users act directly; a bot may only act directly with a short temporary directive.
      if (bot && input.kind === "standing") {
        changed();
        return directive;
      }
      const active = await activate(directive.id);
      changed();
      if (bot) options.notifyUser?.(active);
      return active;
    },

    /** User only (the RPC layer rejects agent callers). */
    async confirm(id: string): Promise<Directive> {
      const d = rows.get(id);
      if (!d) throw new Error("指令不存在");
      if (d.status !== "pending") throw new Error("只有待确认的指令可以确认");
      if (d.expiresAt && d.expiresAt <= now().toISOString()) {
        rows.transition(id, ["pending"], "expired", now().toISOString());
        changed();
        throw new Error("指令已过期");
      }
      const active = await activate(id);
      changed();
      return active;
    },

    async revoke(id: string): Promise<Directive> {
      const d = rows.get(id);
      if (!d) throw new Error("指令不存在");
      if (!rows.transition(id, ["active", "pending"], "revoked", now().toISOString()))
        throw new Error("指令已撤销或已过期");
      if (d.pauseId) await options.pause?.remove?.(d.pauseId);
      changed();
      return rows.get(id) as Directive;
    },

    list: (status?: DirectiveStatus) => rows.list(status),

    /** Mark due directives expired; returns them. */
    expireDue(): Directive[] {
      const at = now().toISOString();
      const expired = rows.due(at).filter((d) => rows.transition(d.id, ["active"], "expired", at));
      if (expired.length) changed();
      return expired;
    },
  };
}
export type DirectiveService = ReturnType<typeof createDirectiveService>;
