import { z } from "zod";
export const ContextStatusSchema = z.object({ text: z.string(), workspaceId: z.string() });
