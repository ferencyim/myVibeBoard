import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const scope = z.union([
  z.literal("all"),
  z.object({ kind: z.literal("all") }),
  z.object({ kind: z.literal("projects"), projectIds: z.array(z.string().min(1)).min(1) }),
  z.object({ kind: z.literal("providers"), providers: z.array(z.string().min(1)).min(1) }),
]);
const directive = z.record(z.string(), z.unknown());

/** issuedBy is derived from the caller: an agent caller is always `bot`, the app is `user`. */
export const directiveIssueRpc = defineRpc({
  name: "hub.directive.issue",
  input: z.object({
    text: z.string().min(1).max(4000),
    scope: scope.optional(),
    kind: z.enum(["temporary", "standing"]),
    expiresAt: z.string().nullable().optional(),
    pause: z.object({ scope: z.string().min(1), until: z.string().optional() }).optional(),
  }),
  output: z.object({ directive }),
});
export const directiveConfirmRpc = defineRpc({
  name: "hub.directive.confirm",
  input: z.object({ id: z.string().min(1) }),
  output: z.object({ directive }),
});
export const directiveRevokeRpc = defineRpc({
  name: "hub.directive.revoke",
  input: z.object({ id: z.string().min(1) }),
  output: z.object({ directive }),
});
export const directiveListRpc = defineRpc({
  name: "hub.directive.list",
  input: z.object({ status: z.enum(["active", "pending", "revoked", "expired"]).optional() }),
  output: z.object({ directives: z.array(directive) }),
});
