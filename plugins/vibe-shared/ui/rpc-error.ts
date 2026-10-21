// Turns an error thrown by a plugin RPC call into one Chinese sentence for a toast or an inline
// message. The client appends ` requestType=… code=…` to every RPC error and the host prefixes
// `Request failed: `; the board service prefixes its own `[code]`. None of that is for users.

const CODE_LABELS: Record<string, string> = {
  invalid: "输入无效",
  conflict: "操作冲突",
  not_found: "找不到",
  illegal_transition: "不能这样移动",
  same_column: "不能这样移动",
  actor_not_allowed: "没有权限",
  illegal_create: "不能这样创建",
  illegal_session_transition: "会话状态不允许",
  unavailable: "暂不可用",
  dispatch_failed: "派发失败",
  not_admitted: "调度器暂未放行",
  too_large: "文件过大",
};

const COLUMN_LABELS: Record<string, string> = {
  draft: "草稿箱",
  todo: "待办",
  in_progress: "进行中",
  verifying: "待验证",
  done: "已完成",
};
const column = (name: string) => COLUMN_LABELS[name] ?? name;

/** English messages of the shared command layer and the state machine, translated. */
const MESSAGE_PATTERNS: ReadonlyArray<readonly [RegExp, (m: RegExpMatchArray) => string]> = [
  [/^Card not found: (.+)$/, (m) => `找不到卡片：${m[1]}`],
  [/^Project not found: (.+)$/, (m) => `找不到项目：${m[1]}`],
  [/^Preset not found: (.+)$/, (m) => `找不到预设：${m[1]}`],
  [/^Tag not found: (.+)$/, (m) => `找不到标签：${m[1]}`],
  [/^Session not found: (.+)$/, (m) => `找不到会话：${m[1]}`],
  [/^Evidence not found: (.+)$/, (m) => `找不到证据：${m[1]}`],
  [/^Proposal not found: (.+)$/, (m) => `找不到提议：${m[1]}`],
  [/^Card title is required$/, () => "卡片标题不能为空"],
  [/^Chat text is required$/, () => "消息内容不能为空"],
  [/^A preset needs a model$/, () => "预设必须填写模型"],
  [/^Built-in tags cannot be deleted$/, () => "内置标签不能删除"],
  [/^Only draft cards can be deleted; archive others$/, () => "只有草稿箱里的卡片可以删除，其它卡片请归档"],
  [/^Card has sessions; archive it instead$/, () => "这张卡已有执行会话，不能删除，请归档"],
  [/^Preset "(.+)" already exists$/, (m) => `预设“${m[1]}”已存在`],
  [/^Tag "(.+)" already exists$/, (m) => `标签“${m[1]}”已存在`],
  [/^Project prefix "(.+)" already exists$/, (m) => `项目前缀“${m[1]}”已被占用`],
  [/^Invalid project prefix "(.*)" /, (m) => `项目前缀“${m[1]}”无效（大写字母和数字，字母开头，最多 10 位）`],
  [/^Card is already in "(.+)"$/, (m) => `卡片已经在“${column(m[1]!)}”`],
  [/^Cards cannot move from "(.+)" to "(.+)"$/, (m) => `卡片不能从“${column(m[1]!)}”直接移到“${column(m[2]!)}”`],
  [/^"(.+)" may not move a card from "(.+)" to "(.+)"/, (m) => `不允许这样移动：“${column(m[2]!)}”到“${column(m[3]!)}”`],
  [/^A card can only enter in_progress through dispatch/, () => "卡片只能通过派发进入“进行中”（需要有执行会话）"],
  [/^Session already ended: /, () => "这个会话已经结束"],
  [/^Agent already has a session: /, () => "这个 agent 已经有会话了"],
  [/^Unknown field "(.+)" for (.+)$/, (m) => `未知字段“${m[1]}”（${m[2]}）`],
  [/timed? ?out/i, () => "请求超时，请稍后重试"],
];

const CJK = /[㐀-鿿]/;

/** Strip the wire noise, then translate; an already-Chinese server message is kept as is. */
export function formatRpcError(error: unknown): string {
  let text = (error instanceof Error ? error.message : String(error)).trim();
  text = text.replace(/\s+requestType=\S+(?:\s+code=\S+)?\s*$/, "").replace(/^Request failed:\s*/i, "");
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
