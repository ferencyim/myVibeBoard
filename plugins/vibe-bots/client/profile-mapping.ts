export function findBotForAgent<T extends { mainAgentId: string | null }>(bots: readonly T[], agentId: string): T | undefined {
  return bots.find((bot) => bot.mainAgentId === agentId);
}

export const NAME_MAX = 100;
export const TITLE_MAX = 200;
export const INSTRUCTIONS_MAX = 30_000;
export const BACKUP_MAX = 20;
/** Instructions are saved this long after the last keystroke. */
export const INSTRUCTIONS_DEBOUNCE_MS = 400;

export type PermissionMode = "accept-edits" | "auto" | "full";
const PERMISSION_ORDER: readonly PermissionMode[] = ["accept-edits", "auto", "full"];
export const PERMISSION_LABELS: Record<PermissionMode, string> = {
  "accept-edits": "接受编辑",
  auto: "自动",
  full: "完全访问",
};

/** Only a wider permission asks for confirmation; narrowing saves directly. */
export function widensPermission(from: PermissionMode, to: PermissionMode): boolean {
  return PERMISSION_ORDER.indexOf(to) > PERMISSION_ORDER.indexOf(from);
}

export interface TextDraftErrors { name: string | null; title: string | null; instructions: string | null }
export function validateTextDraft(draft: { name: string; title: string; instructions: string }): TextDraftErrors {
  return {
    name: !draft.name.trim() ? "名字不能为空" : draft.name.length > NAME_MAX ? `名字最多 ${NAME_MAX} 个字符` : null,
    title: draft.title.length > TITLE_MAX ? `头衔最多 ${TITLE_MAX} 个字符` : null,
    instructions: draft.instructions.length > INSTRUCTIONS_MAX ? `角色说明超出 ${INSTRUCTIONS_MAX} 个字符（当前 ${draft.instructions.length}）` : null,
  };
}

interface BackupModel { provider: string; model: string; thinking: string }
export function canAddBackupModel(backups: readonly BackupModel[], provider: string, model: string, thinking: string) {
  return !!provider && !!model && backups.length < BACKUP_MAX && !backups.some((item) => item.provider === provider && item.model === model && item.thinking === thinking);
}

/** Right-hand value of the backup-model row. */
export function backupSummary(count: number) {
  return count ? `${count} 个` : "未设置";
}

export function notificationsSummary(value: { enabled: boolean; completed: boolean; failed: boolean }) {
  if (!value.enabled) return "已关闭";
  if (value.completed && value.failed) return "已开启";
  if (!value.completed && !value.failed) return "仅提醒";
  return value.completed ? "完成时" : "失败时";
}

/** Optimistic application of a patch to one bot in a cached list; other bots keep their identity. */
export function applyPatchToList<T extends { id: string }>(bots: readonly T[], id: string, patch: Partial<T>): T[] {
  return bots.map((bot) => (bot.id === id ? { ...bot, ...patch } : bot));
}

/** Replaces a bot by the server's answer; an unknown id leaves the list unchanged. */
export function replaceBotInList<T extends { id: string }>(bots: readonly T[], next: T): T[] {
  return bots.map((bot) => (bot.id === next.id ? next : bot));
}

/** Avatar colors offered in the avatar popover (hue in degrees). */
export const AVATAR_HUES: ReadonlyArray<{ hue: number; label: string }> = [
  { hue: 0, label: "红" }, { hue: 30, label: "橙" }, { hue: 55, label: "黄" }, { hue: 150, label: "绿" },
  { hue: 185, label: "青" }, { hue: 215, label: "蓝" }, { hue: 245, label: "靛" }, { hue: 320, label: "洋红" },
];

export function avatarColor(hue: number) {
  return `hsl(${((hue % 360) + 360) % 360}, 48%, 32%)`;
}

export function avatarInitial(name: string) {
  const first = Array.from(name.trim())[0];
  return first ? first.toLocaleUpperCase("en-US") : "?";
}
