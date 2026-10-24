import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EvidenceFile } from "./vibe/contract";
import { writeThumbnail } from "./thumbnail";
import { createTaskVerificationCommands, type VibeDb } from "./vibe/db";

export function createTaskVerifyStore(db: VibeDb, root: string, now?: () => Date) {
  const commands = createTaskVerificationCommands(db, { now });
  const dirFor = (id: string) => join(root, "tasks", id);
  return {
    ...commands,
    dirFor,
    ensureThumb(evidence: EvidenceFile) {
      if (evidence.thumbPath) return evidence.thumbPath;
      const thumbPath = writeThumbnail(evidence.path);
      if (thumbPath) commands.setThumb(evidence.id, thumbPath);
      return thumbPath;
    },
    addEvidence(
      id: string,
      itemId: string | null,
      artifact: Parameters<typeof commands.addEvidence>[2],
    ) {
      return commands.addEvidence(id, itemId, {
        ...artifact,
        thumbPath:
          artifact.thumbPath ??
          (artifact.kind === "screenshot"
            ? (writeThumbnail(artifact.path) ?? undefined)
            : undefined),
      });
    },
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
