// `vibe-board` CLI. Runs inside the daemon (via the local bridge); the thin bin/vibe-board.mjs
// wrapper only forwards argv. Output is text, or JSON with --json.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  CARD_COLUMNS,
  CARD_PRIORITIES,
  PROJECT_TYPES,
  type CardColumn,
  type CardPriority,
  type CardView,
  type ProjectType,
} from "../vibe/contract";
import { agentActor, USER_ACTOR, type Actor, type BoardService } from "../service";

export interface CliContext {
  cwd?: string;
  /** Paseo agent id of the caller, when run from inside an agent. */
  agentId?: string;
  /** VIBE_ROLE of the caller (master|planner|worker|verifier); absent for a human. */
  role?: string;
}

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr?: string;
}

class CliError extends Error {}

const BOOLEAN_FLAGS = new Set(["json", "evidence", "no-evidence", "ref-image", "archived"]);

interface Args {
  positionals: string[];
  flags: Map<string, string[]>;
}

function parseArgs(argv: readonly string[]): Args {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (!arg.startsWith("--") || arg === "--") {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq < 0 ? undefined : eq);
    let value: string;
    if (eq >= 0) value = arg.slice(eq + 1);
    else if (BOOLEAN_FLAGS.has(name)) value = "true";
    else {
      const next = argv[i + 1];
      if (next === undefined) throw new CliError(`--${name} needs a value`);
      value = next;
      i += 1;
    }
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { positionals, flags };
}

const one = (a: Args, name: string): string | undefined => a.flags.get(name)?.at(-1);
const many = (a: Args, name: string): string[] => a.flags.get(name) ?? [];
const has = (a: Args, name: string): boolean => a.flags.has(name);

function oneOf<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  what: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new CliError(`invalid ${what} "${value}" (one of: ${allowed.join(", ")})`);
  }
  return value as T;
}

function need(value: string | undefined, what: string): string {
  if (!value) throw new CliError(`${what} is required`);
  return value;
}

const line = (value: unknown): string =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

function table(headers: string[], rows: unknown[][], empty: string): string {
  if (rows.length === 0) return empty;
  const cells = rows.map((r) => r.map(line));
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...cells.map((r) => (r[i] ?? "").length)),
  );
  const render = (r: string[]) =>
    r
      .map((v, i) => (i === r.length - 1 ? v : v.padEnd(widths[i] ?? 0)))
      .join("  ")
      .trimEnd();
  return [render(headers), ...cells.map(render)].join("\n");
}

const cardRow = (c: CardView) => [c.key, c.column, c.priority, c.title];

export function eventText(body: unknown): string {
  if (body && typeof body === "object" && "text" in body && typeof body.text === "string") {
    return line(body.text);
  }
  return line(typeof body === "string" ? body : JSON.stringify(body));
}

export const CLI_USAGE = `vibe-board <command>
  project list | project create --name N --prefix ABC [--repo PATH] [--type web]
  list [--project ABC] [--column draft] [--priority high] [--tag NAME] [--search Q] [--limit N] [--archived]
  show KEY
  create --project ABC --title T [--description D] [--priority P] [--acceptance A] [--column draft|todo]
         [--tag NAME]... [--evidence|--no-evidence] [--parent KEY]
  update KEY [--title T] [--description D] [--priority P] [--acceptance A] [--tag NAME]... [--evidence|--no-evidence]
  move KEY --to COLUMN [--reason R]     (agents are refused by the state machine)
  comment KEY --body TEXT
  events KEY
  attachment add KEY --file PATH [--ref-image] | attachment list KEY | attachment get ID --out PATH | attachment rm ID
  tag list | tag create --name N [--evidence]
  preset list
Add --json for machine-readable output. Columns: ${CARD_COLUMNS.join(", ")}.`;

export async function runBoardCli(
  argv: readonly string[],
  board: BoardService,
  ctx: CliContext = {},
): Promise<CliResult> {
  try {
    const args = parseArgs(argv);
    const [command = "help", ...rest] = args.positionals;
    const actor: Actor = ctx.role || ctx.agentId ? agentActor(ctx.role, ctx.agentId) : USER_ACTOR;
    const out = (data: unknown, text: string): CliResult => ({
      exitCode: 0,
      stdout: has(args, "json") ? JSON.stringify(data, null, 2) : text,
    });
    const tagIds = (names: string[]): string[] | undefined => {
      if (names.length === 0) return undefined;
      const all = board.tags.list().tags;
      return names.map((name) => {
        const tag = all.find((t) => t.name.toLowerCase() === name.toLowerCase() || t.id === name);
        if (!tag) throw new CliError(`unknown tag "${name}" (see: tag list)`);
        return tag.id;
      });
    };
    const evidence = has(args, "evidence") ? true : has(args, "no-evidence") ? false : undefined;

    switch (command) {
      case "help":
        return { exitCode: 0, stdout: CLI_USAGE };

      case "project": {
        const sub = rest[0] ?? "list";
        if (sub === "list") {
          const { projects } = board.projects.list(has(args, "archived"));
          return out(
            { projects },
            table(
              ["PREFIX", "NAME", "TYPE", "REPO"],
              projects.map((p) => [p.prefix, p.name, p.projectType, p.repoPath]),
              "No projects.",
            ),
          );
        }
        if (sub === "create") {
          const { project } = board.projects.create({
            name: need(one(args, "name"), "--name"),
            prefix: need(one(args, "prefix"), "--prefix").toUpperCase(),
            repoPath: one(args, "repo") ?? ctx.cwd ?? "",
            projectType: oneOf<ProjectType>(one(args, "type"), PROJECT_TYPES, "--type"),
          });
          return out({ project }, `Created project ${project.prefix} (${project.name})`);
        }
        throw new CliError(`unknown project command "${sub}"`);
      }

      case "list": {
        const { cards, truncated } = board.cards.list({
          project: one(args, "project"),
          column: oneOf<CardColumn>(one(args, "column"), CARD_COLUMNS, "--column"),
          priority: oneOf<CardPriority>(one(args, "priority"), CARD_PRIORITIES, "--priority"),
          tagId: tagIds(many(args, "tag"))?.[0],
          search: one(args, "search"),
          includeArchived: has(args, "archived"),
          limit: one(args, "limit") ? Number(one(args, "limit")) : undefined,
        });
        return out(
          { cards, truncated },
          table(["KEY", "COLUMN", "PRIORITY", "TITLE"], cards.map(cardRow), "No cards.") +
            (truncated ? "\n(truncated; use --limit)" : ""),
        );
      }

      case "show": {
        const d = board.cards.detail(need(rest[0], "card key"));
        const c = d.card;
        const text = [
          `${c.key}  ${c.title}`,
          `column: ${c.column}  priority: ${c.priority}  evidence: ${c.needsEvidence}  tags: ${c.tags.join(",") || "-"}`,
          c.description && `\n${c.description}`,
          c.acceptance && `\nAcceptance:\n${c.acceptance}`,
          d.children.length
            ? `\nSub-cards:\n${table(["KEY", "COLUMN", "PRIORITY", "TITLE"], d.children.map(cardRow), "")}`
            : "",
          d.attachments.length
            ? `\nAttachments:\n${d.attachments.map((a) => `  ${a.id}  ${a.filename} (${a.mimeType}, ${a.sizeBytes} B)`).join("\n")}`
            : "",
          d.events.length
            ? `\nEvents:\n${d.events.map((e) => `  [${e.createdAt}] ${e.type}/${e.authorKind} ${e.author}: ${eventText(e.body)}`).join("\n")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n");
        return out(d, text);
      }

      case "create": {
        const { card } = board.cards.create(
          {
            project: need(one(args, "project"), "--project"),
            title: need(one(args, "title"), "--title"),
            description: one(args, "description"),
            priority: oneOf<CardPriority>(one(args, "priority"), CARD_PRIORITIES, "--priority"),
            acceptance: one(args, "acceptance"),
            column: oneOf<"draft" | "todo">(one(args, "column"), ["draft", "todo"], "--column"),
            tagIds: tagIds(many(args, "tag")),
            needsEvidence: evidence,
            parentCardId: one(args, "parent"),
          },
          actor,
        );
        return out({ card }, `Created ${card.key} in ${card.column}: ${card.title}`);
      }

      case "update": {
        const { card } = board.cards.update(need(rest[0], "card key"), {
          title: one(args, "title"),
          description: one(args, "description"),
          priority: oneOf<CardPriority>(one(args, "priority"), CARD_PRIORITIES, "--priority"),
          acceptance: one(args, "acceptance"),
          tagIds: tagIds(many(args, "tag")),
          needsEvidence: evidence,
        });
        return out({ card }, `Updated ${card.key}`);
      }

      case "move": {
        const to = oneOf<CardColumn>(need(one(args, "to"), "--to"), CARD_COLUMNS, "--to");
        const { card } = board.cards.move(need(rest[0], "card key"), {
          to: to as CardColumn,
          actor: actor.move,
          reason: one(args, "reason"),
        });
        return out({ card }, `Moved ${card.key} to ${card.column}`);
      }

      case "comment": {
        const key = need(rest[0], "card key");
        const { event } = board.events.add(key, { text: need(one(args, "body"), "--body") }, actor);
        return out({ event }, `Commented on ${key}`);
      }

      case "events": {
        const { events } = board.events.list(need(rest[0], "card key"));
        return out(
          { events },
          table(
            ["WHEN", "TYPE", "AUTHOR", "TEXT"],
            events.map((e) => [e.createdAt, e.type, `${e.authorKind}:${e.author}`, eventText(e.body)]),
            "No events.",
          ),
        );
      }

      case "attachment":
        return await attachmentCommand(rest, args, board, ctx, out);

      case "tag": {
        if ((rest[0] ?? "list") === "create") {
          const { tag } = board.tags.create(need(one(args, "name"), "--name"), has(args, "evidence"));
          return out({ tag }, `Created tag ${tag.name}`);
        }
        const { tags } = board.tags.list();
        return out(
          { tags },
          table(["NAME", "EVIDENCE", "ID"], tags.map((t) => [t.name, t.evidence, t.id]), "No tags."),
        );
      }

      case "preset": {
        const { presets } = board.presets.list();
        return out(
          { presets },
          table(
            ["NAME", "PROVIDER", "MODEL", "PERMISSION"],
            presets.map((p) => [p.name, p.provider, p.model, p.permissionMode]),
            "No presets.",
          ),
        );
      }

      default:
        throw new CliError(`unknown command "${command}"\n${CLI_USAGE}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: "", stderr: `Error: ${message}` };
  }
}

async function attachmentCommand(
  rest: string[],
  args: Args,
  board: BoardService,
  ctx: CliContext,
  out: (data: unknown, text: string) => CliResult,
): Promise<CliResult> {
  const [sub = "list", target] = rest;
  const base = ctx.cwd ?? process.cwd();
  if (sub === "add") {
    const file = resolve(base, need(one(args, "file"), "--file"));
    const { attachment } = board.attachments.upload(need(target, "card key"), {
      fileName: basename(file),
      bytes: await readFile(file),
      asRefImage: has(args, "ref-image"),
    });
    return out({ attachment }, `Attached ${attachment.filename} (${attachment.id})`);
  }
  if (sub === "list") {
    const { attachments } = board.attachments.list(need(target, "card key"));
    return out(
      { attachments },
      table(
        ["ID", "FILE", "TYPE", "SIZE"],
        attachments.map((a) => [a.id, a.filename, a.mimeType, a.sizeBytes]),
        "No attachments.",
      ),
    );
  }
  if (sub === "get") {
    const { attachment, content } = board.attachments.read(need(target, "attachment id"));
    const dest = resolve(base, one(args, "out") ?? attachment.filename);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, content);
    return out({ attachment, path: dest }, `Saved ${attachment.filename} to ${dest}`);
  }
  if (sub === "rm") {
    const { deleted } = board.attachments.delete(need(target, "attachment id"));
    return out({ deleted }, deleted ? "Deleted" : "Not found");
  }
  throw new CliError(`unknown attachment command "${sub}"`);
}
