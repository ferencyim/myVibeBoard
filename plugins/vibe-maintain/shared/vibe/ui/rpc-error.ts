// GENERATED FROM plugins/vibe-shared — DO NOT EDIT (run: node scripts/vibe/sync-shared.mjs)
// Turns an error thrown by a plugin RPC call into one Chinese sentence for a toast or an inline
// message. The client appends ` requestType=… code=…` to every RPC error and the host prefixes
// `Request failed: `; the board service prefixes its own `[code]`. None of that is for users.

const CODE_LABELS: Record<string, string> = {
  invalid: "输入无效",
  conflict: "操作冲突",
  not_found: "找不到",
  illegal_session_transition: "会话状态不允许",
  unavailable: "暂不可用",
  dispatch_failed: "派发失败",
  not_admitted: "调度器暂未放行",
  too_large: "文件过大",
};

/** English messages of the shared command layer and the state machine, translated. */
const MESSAGE_PATTERNS: ReadonlyArray<readonly [RegExp, (m: RegExpMatchArray) => string]> = [
  [/^Project not found: (.+)$/, (m) => `找不到项目：${m[1]}`],
  [/^Preset not found: (.+)$/, (m) => `找不到预设：${m[1]}`],
  [/^Session not found: (.+)$/, (m) => `找不到会话：${m[1]}`],
  [/^Evidence not found: (.+)$/, (m) => `找不到证据：${m[1]}`],
  [/^A preset needs a model$/, () => "预设必须填写模型"],
  [/^Preset "(.+)" already exists$/, (m) => `预设“${m[1]}”已存在`],
  [/^Project prefix "(.+)" already exists$/, (m) => `项目前缀“${m[1]}”已被占用`],
  [
    /^Invalid project prefix "(.*)" /,
    (m) => `项目前缀“${m[1]}”无效（大写字母和数字，字母开头，最多 10 位）`,
  ],
  [/^Session already ended: /, () => "这个会话已经结束"],
  [/^Agent already has a session: /, () => "这个 agent 已经有会话了"],
  [/^Unknown field "(.+)" for (.+)$/, (m) => `未知字段“${m[1]}”（${m[2]}）`],
  [/timed? ?out/i, () => "请求超时，请稍后重试"],
];

const CJK = /[㐀-鿿]/;

/** Strip the wire noise, then translate; an already-Chinese server message is kept as is. */
export function formatRpcError(error: unknown): string {
  let text = (error instanceof Error ? error.message : String(error)).trim();
  text = text
    .replace(/\s+requestType=\S+(?:\s+code=\S+)?\s*$/, "")
    .replace(/^Request failed:\s*/i, "");
  const tagged = /^\[([a-z_]+)\]\s*([\s\S]*)$/.exec(text);
  const code = tagged?.[1];
  const message = (tagged ? tagged[2]! : text).trim();
  if (!message) return code ? (CODE_LABELS[code] ?? "操作失败") : "操作失败";
  if (CJK.test(message)) return message;
  for (const [pattern, translate] of MESSAGE_PATTERNS) {
    const match = pattern.exec(message);
    if (match) return translate(match);
  }
  const label = code ? CODE_LABELS[code] : undefined;
  return label ? `${label}：${message}` : message;
}
