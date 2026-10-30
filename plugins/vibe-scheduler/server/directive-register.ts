// Wires the directive service into the scheduler plugin: RPCs, expiry timer, global-file sync.

import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  directiveConfirmRpc,
  directiveIssueRpc,
  directiveListRpc,
  directiveRevokeRpc,
} from "../shared/directive-rpc";
import {
  defaultDirectiveFiles,
  syncDirectiveFiles,
  type DirectiveFileTarget,
} from "./directive-files";
import { createDirectiveService, type PauseGateway } from "./directives";
import type { VibeDb } from "./vibe/db";

export interface RegisterDirectiveOptions {
  /** WP-170's `hub.pause.create` adapter; without it a directive's pause field is not enforced. */
  pause?: PauseGateway;
  files?: DirectiveFileTarget[];
  tickMs?: number;
}

// The page shows scope "all" as a plain string; narrower scopes stay objects.
const asRecord = (value: unknown) => {
  const d = value as { scope?: { kind?: string } };
  return (d.scope?.kind === "all" ? { ...d, scope: "all" } : d) as Record<string, unknown>;
};

export function registerDirectives(
  server: PluginServerContext,
  db: VibeDb,
  options: RegisterDirectiveOptions = {},
) {
  const files = options.files ?? defaultDirectiveFiles();
  const log = (message: string) => console.warn(message);
  const service = createDirectiveService({
    db,
    pause: options.pause,
    notifyUser: (d) =>
      server.notify({ title: "总协调已下发临时指令", body: d.text.slice(0, 200), data: { directiveId: d.id } }),
    onChange: () => syncDirectiveFiles(files, service.list("active"), log),
  });

  server.handle(directiveIssueRpc, async (input, { callerAgentId }) => ({
      directive: asRecord(
        await service.issue({
          ...input,
          scope: input.scope === "all" ? { kind: "all" } : input.scope,
          issuedBy: callerAgentId ? "bot" : "user" }),
      ),
    }));
  server.handle(directiveConfirmRpc, async ({ id }, { callerAgentId }) => {
    if (callerAgentId) throw new Error("长期规则只能由用户确认");
    return { directive: asRecord(await service.confirm(id)) };
  });
  server.handle(directiveRevokeRpc, async ({ id }, { callerAgentId }) => {
    const found = service.list().find((d) => d.id === id);
    if (callerAgentId && found?.issuedBy === "user") throw new Error("bot 不能撤销用户下发的指令");
    return { directive: asRecord(await service.revoke(id)) };
  });
  server.handle(directiveListRpc, ({ status }) => ({
    directives: service.list(status).map(asRecord),
  }));
  const tick = () => {
    try {
      for (const d of service.expireDue())
        server.notify({ title: "全局指令已到期", body: d.text.slice(0, 200), data: { directiveId: d.id } });
    } catch (error) {
      console.error("vibe-scheduler: 指令到期检查失败：", error);
    }
  };
  tick();
  syncDirectiveFiles(files, service.list("active"), log);
  const timer = setInterval(tick, options.tickMs ?? 30_000);
  (timer as unknown as { unref?: () => void }).unref?.();
  return Object.assign(() => clearInterval(timer), { service });
}
