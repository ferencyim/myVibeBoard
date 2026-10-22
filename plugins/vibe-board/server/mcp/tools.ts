// Board MCP tools (vibe_*): how agents (master, planners, workers, verifiers) read and write
// cards. Moves are deliberately absent: columns are decided by the user, dispatcher, lifecycle
// and verifier, never through a tool call.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  CARD_PRIORITIES,
  CARD_COLUMNS,
  type CardColumn,
  type CardPriority,
} from "../vibe/contract";
import { agentActor, toBoardError, type BoardService } from "../service";
import type { SubtaskService } from "../subtasks";

/** Services the tools need beyond the board (WP-106 sub-agents). */
export interface McpServices {
  subtasks?: Pick<SubtaskService, "status" | "start" | "message" | "mark"> | null;
}

export interface McpCaller {
  agentId?: string;
  role?: string;
}

const str = (description: string) => ({ type: "string", description });

export const MCP_TOOLS = [
  {
    name: "vibe_projects",
    description: "List board projects with their key prefixes (e.g. PROD) and repo paths.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "vibe_list",
    description:
      "List cards, optionally filtered. Columns: draft, todo, in_progress, verifying, done. Ordered as on the board.",
    inputSchema: {
      type: "object",
      properties: {
        project: str("Project prefix or id (e.g. PROD)"),
        column: { type: "string", enum: [...CARD_COLUMNS] },
        priority: { type: "string", enum: [...CARD_PRIORITIES] },
        search: str("Text to find in key, title or description"),
        limit: { type: "number", description: "Maximum cards (default 500)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "vibe_show",
    description:
      "Show a card by key (PROD-12) or id: fields, tags, acceptance criteria, sub-cards, attachments, timeline events and plan versions.",
    inputSchema: {
      type: "object",
      properties: { key: str("Card key such as PROD-12") },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "vibe_create",
    description:
      "Create a card in the draft column (a person moves it to todo). Use parent to create a sub-card.",
    inputSchema: {
      type: "object",
      properties: {
        project: str("Project prefix or id"),
        title: str("Card title"),
        description: str("Markdown description"),
        priority: { type: "string", enum: [...CARD_PRIORITIES] },
        acceptance: str("Acceptance criteria (Markdown checklist)"),
        tags: { type: "array", items: { type: "string" }, description: "Tag names (bug, feature, ...)" },
        needsEvidence: { type: "boolean", description: "Verification must capture evidence" },
        parent: str("Parent card key for a sub-card"),
      },
      required: ["project", "title"],
      additionalProperties: false,
    },
  },
  {
    name: "vibe_update",
    description:
      "Update a card's title, description, priority, acceptance criteria, tags or evidence flag. Cannot move columns.",
    inputSchema: {
      type: "object",
      properties: {
        key: str("Card key such as PROD-12"),
        title: str("New title"),
        description: str("New Markdown description"),
        priority: { type: "string", enum: [...CARD_PRIORITIES] },
        acceptance: str("New acceptance criteria"),
        tags: { type: "array", items: { type: "string" }, description: "Replace tags (names)" },
        needsEvidence: { type: "boolean" },
      },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "vibe_comment",
    description: "Add a Markdown note to a card's timeline (progress, findings, questions).",
    inputSchema: {
      type: "object",
      properties: { key: str("Card key such as PROD-12"), body: str("Markdown text") },
      required: ["key", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "vibe_attach",
    description:
      "Attach a local file to a card (e.g. a screenshot or report). Set refImage to also list it as a reference image.",
    inputSchema: {
      type: "object",
      properties: {
        key: str("Card key such as PROD-12"),
        path: str("Path of the file to attach"),
        fileName: str("Override the stored file name"),
        refImage: { type: "boolean" },
      },
      required: ["key", "path"],
      additionalProperties: false,
    },
  },
  {
    name: "vibe_session_note",
    description:
      "Save your session progress notes (goal, done, in progress, next steps, key files, open questions) to this card's .vibe/sessions/<card>.md in your worktree. Overwrites the previous notes. Use this instead of writing the file yourself.",
    inputSchema: {
      type: "object",
      properties: { key: str("Card key such as PROD-12 (or card id)"), text: str("Markdown notes") },
      required: ["key", "text"],
      additionalProperties: false,
    },
  },
  // WP-106: the main agent coordinates the plan's subtasks; the board starts the sub-agents.
  {
    name: "vibe_subtask_status",
    description:
      "Main agent only. List the card's subtasks with their status (pending/running/waiting/done/failed), model, dependencies, files, the sub-agent's last summary or question, and why a subtask cannot start yet.",
    inputSchema: {
      type: "object",
      properties: { key: str("Card key such as PROD-12") },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "vibe_subtask_start",
    description:
      "Main agent only. Ask the board to start the sub-agent of one subtask in the card's worktree. The board refuses (and says why) when a dependency is not done, the subtask is already running, its files overlap a running subtask, or the concurrency limit is reached. You are notified when the sub-agent finishes, fails or asks something.",
    inputSchema: {
      type: "object",
      properties: {
        key: str("Card key such as PROD-12"),
        subtask: str("Subtask id such as s1"),
        instructions: str("Extra instructions for this sub-agent (optional)"),
      },
      required: ["key", "subtask"],
      additionalProperties: false,
    },
  },
  {
    name: "vibe_subtask_message",
    description:
      "Main agent only. Send a message to a subtask's sub-agent: answers its open question, or gives it new instructions (an ended sub-agent is resumed).",
    inputSchema: {
      type: "object",
      properties: {
        key: str("Card key such as PROD-12"),
        subtask: str("Subtask id such as s1"),
        text: str("Message for the sub-agent"),
      },
      required: ["key", "subtask", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "vibe_subtask_mark",
    description:
      "Main agent only. Record a subtask's status yourself: done (for example you did it), failed (given up) or pending (to start it again later), with a short note.",
    inputSchema: {
      type: "object",
      properties: {
        key: str("Card key such as PROD-12"),
        subtask: str("Subtask id such as s1"),
        status: { type: "string", enum: ["done", "failed", "pending"] },
        note: str("Why / what was done"),
      },
      required: ["key", "subtask", "status"],
      additionalProperties: false,
    },
  },
] as const;

const READ_ONLY_TOOLS = new Set(["vibe_projects", "vibe_list", "vibe_show", "vibe_comment"]);
const SUBTASK_TOOLS = new Set(["vibe_subtask_status", "vibe_subtask_start", "vibe_subtask_message", "vibe_subtask_mark"]);

/**
 * Tools visible to a role. Verifiers are read-only (they may only comment); the subtask tools are
 * for the main agent (worker) and callers whose role is unknown (some providers do not pass env to
 * MCP servers), never for sub-agents, verifiers, planners or the master.
 */
export function toolsForRole(role: string | undefined) {
  if (role === "verifier") return MCP_TOOLS.filter((t) => READ_ONLY_TOOLS.has(t.name));
  if (role === undefined || role === "worker") return MCP_TOOLS;
  return MCP_TOOLS.filter((t) => !SUBTASK_TOOLS.has(t.name));
}

const text = (value: unknown) => (typeof value === "string" ? value : undefined);

function subtasksOf(services: McpServices) {
  if (!services.subtasks) throw new Error("Sub-agents are not available in this board process");
  return services.subtasks;
}

function tagIds(board: BoardService, names: unknown): string[] | undefined {
  if (!Array.isArray(names)) return undefined;
  const all = board.tags.list().tags;
  return names.map((n) => {
    const tag = all.find((t) => t.name.toLowerCase() === String(n).toLowerCase() || t.id === n);
    if (!tag) throw new Error(`Unknown tag "${n}" (known: ${all.map((t) => t.name).join(", ")})`);
    return tag.id;
  });
}

export async function callMcpTool(
  name: string,
  args: Record<string, unknown>,
  board: BoardService,
  caller: McpCaller,
  services: McpServices = {},
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const result = (data: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  });
  try {
    if (!toolsForRole(caller.role).some((t) => t.name === name)) {
      throw new Error(`Tool not available${MCP_TOOLS.some((t) => t.name === name) ? ` for role ${caller.role}` : ""}: ${name}`);
    }
    const actor = agentActor(caller.role, caller.agentId);
    const key = String(args.key ?? "");
    switch (name) {
      case "vibe_projects":
        return result(board.projects.list());
      case "vibe_list":
        return result(
          board.cards.list({
            project: text(args.project),
            column: text(args.column) as CardColumn | undefined,
            priority: text(args.priority) as CardPriority | undefined,
            search: text(args.search),
            limit: typeof args.limit === "number" ? args.limit : undefined,
          }),
        );
      case "vibe_show":
        return result(board.cards.detail(key));
      case "vibe_create":
        return result(
          board.cards.create(
            {
              project: String(args.project ?? ""),
              title: String(args.title ?? ""),
              description: text(args.description),
              priority: text(args.priority) as CardPriority | undefined,
              acceptance: text(args.acceptance),
              tagIds: tagIds(board, args.tags),
              needsEvidence: typeof args.needsEvidence === "boolean" ? args.needsEvidence : undefined,
              parentCardId: text(args.parent),
            },
            actor,
          ),
        );
      case "vibe_update":
        return result(
          board.cards.update(key, {
            title: text(args.title),
            description: text(args.description),
            priority: text(args.priority) as CardPriority | undefined,
            acceptance: text(args.acceptance),
            tagIds: tagIds(board, args.tags),
            needsEvidence: typeof args.needsEvidence === "boolean" ? args.needsEvidence : undefined,
          }),
        );
      case "vibe_comment":
        return result(board.events.add(key, { text: String(args.body ?? "") }, actor));
      case "vibe_attach": {
        const file = resolve(String(args.path ?? ""));
        return result(
          board.attachments.upload(key, {
            fileName: text(args.fileName) ?? basename(file),
            bytes: await readFile(file),
            asRefImage: args.refImage === true,
          }),
        );
      }
      case "vibe_session_note": {
        // MCP servers of some providers (codex) do not see the agent's env, so the caller is not
        // identifiable: the card comes from the argument.
        const { card } = board.cards.detail(key);
        if (!card.worktree) throw new Error(`Card ${card.key} has no worktree to save notes in`);
        const file = join(card.worktree, ".vibe", "sessions", `${card.id}.md`);
        await mkdir(join(card.worktree, ".vibe", "sessions"), { recursive: true });
        await writeFile(file, String(args.text ?? ""), "utf8");
        return result({ saved: file });
      }
      case "vibe_subtask_status":
        return result(subtasksOf(services).status(key));
      case "vibe_subtask_start":
        return result(await subtasksOf(services).start(key, String(args.subtask ?? ""), text(args.instructions)));
      case "vibe_subtask_message":
        return result(await subtasksOf(services).message(key, String(args.subtask ?? ""), String(args.text ?? ""), "main"));
      case "vibe_subtask_mark": {
        const status = String(args.status ?? "");
        if (status !== "done" && status !== "failed" && status !== "pending") throw new Error(`Unknown status: ${status}`);
        return result(subtasksOf(services).mark(key, String(args.subtask ?? ""), status, String(args.note ?? "")));
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: toBoardError(error).message }],
    };
  }
}
