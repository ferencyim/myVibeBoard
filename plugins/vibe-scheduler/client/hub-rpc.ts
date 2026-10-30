// Client-side contracts of the hub RPCs provided by WP-170 (hub.status/queue/resources/settings/pause)
// and WP-172 (hub.directive.*). Outputs stay loose; hub-model.ts parses them defensively.
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const loose = z.record(z.string(), z.unknown());

export const hubStatusRpc = defineRpc({ name: "hub.status", input: z.object({}), output: loose });
export const hubQueueReorderRpc = defineRpc({
  name: "hub.queue.reorder",
  input: z.object({
    /** Waiting job ids in the desired order. */
    order: z.array(z.string()).max(1000),
    priorities: z.record(z.string(), z.number().int().min(0).max(9)).optional(),
    reason: z.string().max(1000).optional(),
  }),
  output: loose,
});
export const hubResourceUpsertRpc = defineRpc({
  name: "hub.resources.upsert",
  input: z.object({ name: z.string().min(1), limit: z.number().int().min(1).max(64) }),
  output: loose,
});
export const hubResourceRemoveRpc = defineRpc({
  name: "hub.resources.remove",
  input: z.object({ name: z.string().min(1) }),
  output: loose,
});
export const hubSettingsGetRpc = defineRpc({
  name: "hub.settings.get",
  input: z.object({}),
  output: loose,
});
export const hubSettingsSetRpc = defineRpc({
  name: "hub.settings.set",
  input: z.object({ thresholds: z.record(z.string(), z.number()) }),
  output: loose,
});
const takeoverShape = z.object({
  enabled: z.boolean(),
  active: z.boolean(),
  available: z.boolean(),
  disabledFile: z.boolean(),
});
export const hubTakeoverGetRpc = defineRpc({
  name: "hub.takeover.get",
  input: z.object({}),
  output: takeoverShape,
});
export const hubTakeoverSetRpc = defineRpc({
  name: "hub.takeover.set",
  input: z.object({ enabled: z.boolean() }),
  output: takeoverShape,
});
export const hubPauseCreateRpc = defineRpc({
  name: "hub.pause.create",
  input: z.object({ scope: z.string().min(1), until: z.string(), reason: z.string().min(1) }),
  output: loose,
});
export const hubPauseRevokeRpc = defineRpc({
  name: "hub.pause.revoke",
  input: z.object({ id: z.string().min(1) }),
  output: loose,
});
export const hubDirectiveListRpc = defineRpc({
  name: "hub.directive.list",
  input: z.object({}),
  output: loose,
});
export const hubDirectiveIssueRpc = defineRpc({
  name: "hub.directive.issue",
  input: z.object({
    text: z.string().min(1),
    scope: z.string(),
    kind: z.enum(["temporary", "standing"]),
    expiresAt: z.string().optional(),
  }),
  output: loose,
});
export const hubDirectiveConfirmRpc = defineRpc({
  name: "hub.directive.confirm",
  input: z.object({ id: z.string().min(1) }),
  output: loose,
});
export const hubDirectiveRevokeRpc = defineRpc({
  name: "hub.directive.revoke",
  input: z.object({ id: z.string().min(1) }),
  output: loose,
});
