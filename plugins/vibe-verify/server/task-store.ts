import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTaskVerificationCommands, type VibeDb } from "./vibe/db";

export function createTaskVerifyStore(db: VibeDb, root: string, now?: () => Date) {
  const commands = createTaskVerificationCommands(db, { now });
  const dirFor = (id: string) => join(root, "tasks", id);
  return {
    ...commands,
    dirFor,
    writeNotes(id: string, notes: string[]) {
      mkdirSync(dirFor(id), { recursive: true });
      writeFileSync(join(dirFor(id), "notes.json"), JSON.stringify(notes, null, 2));
    },
    detail(id: string) {
      const verification = commands.get(id);
      if (!verification) return null;
      let notes: string[] = [];
      try {
        notes = JSON.parse(readFileSync(join(dirFor(id), "notes.json"), "utf8"));
      } catch {
        /* Interrupted runs may not yet have notes. */
      }
      return { verification, items: commands.items(id), evidence: commands.evidence(id), notes };
    },
  };
}
export type TaskVerifyStore = ReturnType<typeof createTaskVerifyStore>;
