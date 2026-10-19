import type { PluginTimelineTransformResult } from "@getpaseo/plugin";
import { TASK_CARD_KIND, TASK_KEY_PATTERN, TASK_TEXT_KIND } from "./constants";

const DIRECTIVE_LINE_REGEX = /^::task\{([^}]*)\}\s*$/;

export interface ParsedTaskDirective {
  taskKey: string;
  fallbackTitle: string | null;
  valid: boolean;
}

export function parseTaskDirectiveAttributes(attrText: string): ParsedTaskDirective {
  const attrs: Record<string, string> = {};
  const attrRegex = /([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(attrText)) !== null) {
    const key = match[1];
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (key) attrs[key] = value;
  }
  const rawKey = (attrs.key ?? "").trim();
  const valid = TASK_KEY_PATTERN.test(rawKey);
  return {
    taskKey: valid ? rawKey.toUpperCase() : rawKey,
    fallbackTitle: (attrs.title ?? "").trim() || null,
    valid,
  };
}

export function transformAssistantTaskDirectives(
  text: string,
  phase: "streaming" | "complete",
): PluginTimelineTransformResult | undefined {
  if (!text.includes("::task{")) return undefined;

  const lines = text.split("\n");
  const segments: Array<
    | { kind: "text"; text: string }
    | { kind: "directive"; directive: ParsedTaskDirective }
  > = [];

  let currentTextLines: string[] = [];
  let foundDirective = false;

  for (const line of lines) {
    const match = DIRECTIVE_LINE_REGEX.exec(line.trim());
    if (match) {
      foundDirective = true;
      if (currentTextLines.length > 0) {
        const chunk = currentTextLines.join("\n").trim();
        if (chunk.length > 0) {
          segments.push({ kind: "text", text: chunk });
        }
        currentTextLines = [];
      }
      segments.push({
        kind: "directive",
        directive: parseTaskDirectiveAttributes(match[1] ?? ""),
      });
    } else {
      currentTextLines.push(line);
    }
  }

  if (!foundDirective) return undefined;

  if (currentTextLines.length > 0) {
    const chunk = currentTextLines.join("\n").trim();
    if (chunk.length > 0) {
      segments.push({ kind: "text", text: chunk });
    }
  }

  const items: PluginTimelineTransformResult["items"] = segments.map(
    (segment): PluginTimelineTransformResult["items"][number] => {
      if (segment.kind === "text") {
        return {
          type: "plugin" as const,
          kind: TASK_TEXT_KIND,
          version: 1,
          data: {
            text: segment.text,
            phase,
          },
        };
      }
      return {
        type: "plugin" as const,
        kind: TASK_CARD_KIND,
        version: 1,
        data: {
          taskKey: segment.directive.taskKey,
          fallbackTitle: segment.directive.fallbackTitle,
          valid: segment.directive.valid,
          phase,
        },
      };
    },
  );

  return { items };
}
