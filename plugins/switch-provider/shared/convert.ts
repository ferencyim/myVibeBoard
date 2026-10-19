import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const switchSession = defineRpc({
  name: "session.switch",
  input: z.object({ agentId: z.string().regex(/^[\w-]+$/), provider: z.string(), modelId: z.string() }),
  output: z.object({ agentId: z.string(), method: z.enum(["converted", "transcript"]) }),
});
