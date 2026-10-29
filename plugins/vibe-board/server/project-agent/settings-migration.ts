import { z } from "zod";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export function migrateProjectMaintenance(values: unknown, legacy: Record<string, unknown>) {
  const next =
    values && typeof values === "object" ? ({ ...values } as Record<string, unknown>) : {};
  if (next.projectMaintenanceMigrated) return next;
  const keys = {
    projectConsolidateOnDone: "consolidateOnDone",
    projectMaintainRequirements: "maintainRequirements",
    projectSweepOnStart: "sweepOnStart",
  };
  for (const [key, old] of Object.entries(keys))
    if (next[key] === undefined && typeof legacy[old] === "boolean") next[key] = legacy[old];
  return { ...next, projectMaintenanceMigrated: true };
}
export async function readLegacyMaintenance(values: unknown) {
  if (
    values &&
    typeof values === "object" &&
    "projectMaintenanceMigrated" in values &&
    values.projectMaintenanceMigrated
  )
    return values;
  try {
    const file = join(
      process.env.PASEO_HOME ?? join(homedir(), ".paseo"),
      "plugin-settings",
      "vibe-master",
      "preferences.json",
    );
    const parsed = z
      .object({ values: z.record(z.string(), z.unknown()) })
      .parse(JSON.parse(await readFile(file, "utf8")));
    const saved = parsed.values.legacyProjectMaintenance;
    const legacy =
      saved && typeof saved === "object"
        ? z.record(z.string(), z.unknown()).parse(saved)
        : parsed.values;
    return migrateProjectMaintenance(values, legacy);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return migrateProjectMaintenance(values, {});
  }
}
