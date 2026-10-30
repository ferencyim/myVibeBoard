/** Compact relative time for sidebar rows ("刚刚", "5 分钟前", "2 小时前", "3 天前", else a date). */
export function formatRelativeTime(value: string | number | Date | null | undefined, now = Date.now()): string {
  if (value == null) return "";
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "";
  const minutes = Math.floor((now - time) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return new Date(time).toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
}
