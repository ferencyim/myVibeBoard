import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const PROJECT_AGENT_ROLE_LABEL = "vibe.role";
export const PROJECT_AGENT_PROJECT_LABEL = "vibe.project_id";
export const ProjectAgentStateSchema = z.object({
  agentId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  error: z.string().nullable(),
});
export type ProjectAgentState = z.infer<typeof ProjectAgentStateSchema>;
export const projectAgentOpenRpc = defineRpc({
  name: "vibe.project.agent.open",
  input: z.object({ projectId: z.string().min(1) }),
  output: ProjectAgentStateSchema,
});
export const projectAgentStateRpc = defineRpc({
  name: "vibe.project.agent.state",
  input: z.object({ projectId: z.string().min(1) }),
  output: ProjectAgentStateSchema,
});
export const projectRouteStatusSchema = z.object({
  text: z.string(),
  agentId: z.string(),
  workspaceId: z.string(),
});
