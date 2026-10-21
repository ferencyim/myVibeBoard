// GENERATED FROM plugins/vibe-shared — DO NOT EDIT (run: node scripts/vibe/sync-shared.mjs)
// Repository-relative path rules shared by the daemon and the phone (project.requirementsPath).

/** true for a plain relative path: no absolute/UNC/drive form, no `..` segment, no NUL. */
export function isSafeRepoRelativePath(value: string): boolean {
  if (!value || value.includes("\0")) return false;
  if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value)) return false;
  const segments = value.split(/[\/]/);
  return !segments.includes("..") && segments.some((s) => s !== "" && s !== ".");
}
