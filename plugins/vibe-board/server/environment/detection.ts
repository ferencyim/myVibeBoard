export type EnvironmentFailureKind = "process_start" | "model_unavailable" | "agent_start";
export function environmentFailure(text: string): EnvironmentFailureKind | null {
  if (
    /failed to create unified exec process|helper_unknown_error|sandbox.{0,60}(initializ|setup|fail)|沙箱.{0,30}(初始化|失败)/i.test(
      text,
    )
  )
    return "process_start";
  if (
    /model.{0,60}(overload|unavailable|not available|capacity)|overloaded|模型.{0,30}(满载|不可用)/i.test(
      text,
    )
  )
    return "model_unavailable";
  if (
    /failed to (start|spawn|launch|initialize).{0,40}(agent|provider|session)|agent.{0,40}(startup|start).{0,30}fail/i.test(
      text,
    )
  )
    return "agent_start";
  return null;
}
/** Restrict retained diagnostics to a small window and one notice per agent and failure class. */
export function createFailureWindow(now = Date.now, cooldownMs = 300_000) {
  const sent = new Map<string, number>();
  return (agentId: string, kind: EnvironmentFailureKind) => {
    const time = now();
    for (const [key, at] of sent) if (time - at >= cooldownMs) sent.delete(key);
    const key = agentId + ":" + kind;
    if (sent.has(key)) return false;
    sent.set(key, time);
    return true;
  };
}
export function diagnosticText(text: string): string {
  return text
    .replace(
      /(["']?(?:api[_-]?key|token|password|secret|authorization)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi,
      "$1[已隐藏凭据]",
    )
    .replace(
      /(?:Bearer\s+|(?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,;"']+/gi,
      "[已隐藏凭据]",
    )
    .replace(/https?:\/\/[^\s)]+/gi, "[已隐藏地址]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[已隐藏地址]")
    .replace(/[A-Z]:[\\/]Users[\\/][^\\/\s]+|\/Users\/[^/\s]+|\/home\/[^/\s]+/gi, "[用户目录]")
    .slice(0, 4000);
}

/** Never interpret a read result, a user quote, or the shell command itself as a failure. */
export function timelineFailureText(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (item.type === "error") return String(item.message ?? "");
  if (item.type !== "tool_call") return null;
  const detail =
    item.detail && typeof item.detail === "object" ? (item.detail as Record<string, unknown>) : {};
  const shell =
    detail.type === "shell" ||
    /exec|shell|command|terminal|bash|powershell/i.test(String(item.name ?? ""));
  if (!shell) return null;
  let output = "";
  if (typeof detail.output === "string") output = detail.output;
  else if (detail.output) output = JSON.stringify(detail.output);
  return (
    [
      item.error ? JSON.stringify(item.error) : "",
      output,
      typeof detail.text === "string" ? detail.text : "",
    ]
      .filter(Boolean)
      .join("\n") || null
  );
}
