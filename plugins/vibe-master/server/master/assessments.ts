// Assessments the master wrote before WP-105 (draft review was removed then). The hand-off summary
// for a new master still lists recent ones, so the old markers stay readable.

import { createHash } from "node:crypto";
import type { CardEvent, CardView } from "../vibe/contract";

/** Hash of what the owner wrote (title, description, acceptance, tags). */
export function contentHash(card: CardView, tagNames: string[]): string {
  return createHash("sha256")
    .update(JSON.stringify([card.title, card.description, card.acceptance, [...tagNames].sort()]))
    .digest("hex")
    .slice(0, 16);
}

interface Marker {
  hash: string;
  failed: boolean;
}

/** The newest master assessment (or recorded failure) and the content hash it was based on. */
export function lastAssessmentMarker(events: readonly CardEvent[]): Marker | null {
  for (const e of [...events].reverse()) {
    const body = e.body as { kind?: string; contentHash?: string } | null;
    if (!body?.contentHash) continue;
    if (e.type === "evaluation" && e.author === "master") return { hash: body.contentHash, failed: false };
    if (e.type === "status" && body.kind === "assessment_failed") return { hash: body.contentHash, failed: true };
    if (e.type === "status" && body.kind === "proposal_applied") return { hash: body.contentHash, failed: false };
  }
  return null;
}
