// Pure text helpers for the chat write-backs (question summaries, turn summaries).

export const TURN_SUMMARY_MAX = 1500;
const QUESTION_MAX = 600;

export function clip(text: string, max: number): string {
  const flat = text.trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The last non-empty assistant message of a turn's timeline, clipped; null when there is none. */
export function lastAssistantText(
  timeline: readonly { type: string; text?: unknown }[],
  max = TURN_SUMMARY_MAX,
): string | null {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i]!;
    if (item.type === "assistant_message" && typeof item.text === "string" && item.text.trim()) {
      const text = item.text.trim();
      return text.length > max ? `${text.slice(0, max - 1)}…\n（完整内容见执行会话）` : text;
    }
  }
  return null;
}

export interface QuestionRequest {
  kind: string;
  name: string;
  title?: string;
  description?: string;
  input?: unknown;
}

/** What the executor is waiting for, in one short Chinese paragraph. */
export function questionSummary(request: QuestionRequest): string {
  if (request.kind === "question") {
    const questions = (request.input as { questions?: Array<{ question?: unknown; options?: unknown }> } | undefined)
      ?.questions;
    const lines = (Array.isArray(questions) ? questions : [])
      .map((q) => {
        const text = typeof q.question === "string" ? q.question.trim() : "";
        const options = Array.isArray(q.options)
          ? q.options
              .map((o) => (typeof o === "string" ? o : (o as { label?: unknown } | null)?.label))
              .filter((o): o is string => typeof o === "string" && !!o)
          : [];
        return text ? `${text}${options.length ? `（可选：${options.join(" / ")}）` : ""}` : "";
      })
      .filter(Boolean);
    if (lines.length > 0) return clip(`执行 agent 提问：${lines.join("；")}`, QUESTION_MAX);
    return clip(`执行 agent 提问：${request.title || request.description || request.name}`, QUESTION_MAX);
  }
  const what = request.title || request.description || request.name;
  return clip(`执行 agent 请求权限：${what}。回复「同意」放行，其它内容视为拒绝并作为说明发给它。`, QUESTION_MAX);
}
