import { createHash, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import type { ProjectIconSource } from "@getpaseo/protocol/messages";

import { writeFileAtomic } from "../server/atomic-file.js";
import type { PersistedProjectRecord, ProjectRegistry } from "../server/workspace-registry.js";
import { getImageDimensions, getProjectIcon, type ProjectIcon } from "./project-icon.js";
import { createBackgroundWorkQueue } from "./background-work.js";

const MAX_ICON_BYTES = 512 * 1024;
const ICON_TOO_LARGE_ERROR = "Icon must be 512 KB or smaller";
const ICON_SNAPSHOT_TTL_MS = 30_000;
const MAX_CACHED_ICON_SNAPSHOTS = 512;
const iconSnapshots = new Map<string, { snapshot: ProjectIconSnapshot; expiresAt: number }>();
const inFlightSnapshots = new Map<string, Promise<ProjectIconSnapshot>>();
const refreshIconInBackground = createBackgroundWorkQueue(2);
let backgroundIconGate: Promise<boolean> | null = null;

/** Delay stale scans during startup; resolving false cancels pending refreshes. */
export function setProjectIconBackgroundGate(gate: Promise<boolean> | null): void {
  backgroundIconGate = gate;
}

// A save validates, writes bytes, and updates the registry. Two concurrent
// saves for one project would interleave those steps.
const inFlightSaves = new Map<string, Promise<unknown>>();

/**
 * The only writer of custom project icons. The client owns image acquisition;
 * this boundary accepts bytes, validates them, and replaces whatever was stored.
 */
export async function setProjectCustomIcon(input: {
  paseoHome: string;
  projectId: string;
  source: ProjectIconSource;
  projects: ProjectRegistry;
}): Promise<PersistedProjectRecord> {
  return serialize(input.projectId, async () => {
    if (!(await input.projects.get(input.projectId))) throw new Error("Project not found");

    let customIconRevision: string | null = null;
    if (input.source.type === "automatic") {
      await removeProjectCustomIcon(input);
    } else {
      const bytes = Buffer.from(input.source.data, "base64");
      validateIcon(bytes);
      await writeFileAtomic(cachePath(input.paseoHome, input.projectId), bytes);
      customIconRevision = randomUUID();
    }

    invalidateIconSnapshots(input.paseoHome, input.projectId);

    const updated = await input.projects.update(input.projectId, (current) => ({
      ...current,
      customIconRevision,
      updatedAt: new Date().toISOString(),
    }));
    if (!updated) {
      // The project was removed mid-save, so its own cleanup missed these bytes.
      await removeProjectCustomIcon(input);
      throw new Error("Project not found");
    }
    return updated;
  });
}

/** Resolves the icon a project renders with, whichever mode it is in. */
export async function readProjectIcon(input: {
  paseoHome: string;
  project: PersistedProjectRecord;
}): Promise<ProjectIcon | null> {
  return (await readProjectIconSnapshot(input)).icon;
}

export interface ProjectIconSnapshot {
  icon: ProjectIcon | null;
  revision: string;
}

/** Keeps the icon bytes served by a session aligned with its advertised revision. */
export class ProjectIconReader {
  private readonly snapshots = new Map<string, ProjectIconSnapshot>();

  constructor(private readonly paseoHome: string) {}

  async snapshot(project: PersistedProjectRecord): Promise<ProjectIconSnapshot> {
    // Sessions share the expensive automatic directory scan. A custom revision
    // changes immediately on save; automatic filesystem changes are picked up
    // after the short TTL.
    const key = JSON.stringify([
      this.paseoHome,
      project.projectId,
      project.rootPath,
      project.customIconRevision,
    ]);
    const cached = iconSnapshots.get(key);
    let snapshot: ProjectIconSnapshot;
    if (!cached || cached.expiresAt <= Date.now()) {
      let pending = inFlightSnapshots.get(key);
      if (!pending) {
        // A cache miss is a foreground request. An expired snapshot is still
        // usable, so bound its background scan independently of foreground work.
        const gate = backgroundIconGate;
        pending = cached
          ? (gate ?? Promise.resolve(true)).then((allowed) =>
              allowed
                ? refreshIconInBackground(() =>
                    readProjectIconSnapshot({ paseoHome: this.paseoHome, project }),
                  )
                : cached.snapshot,
            )
          : readProjectIconSnapshot({ paseoHome: this.paseoHome, project });
        inFlightSnapshots.set(key, pending);
        void pending.then(
          (result) => {
            if (inFlightSnapshots.get(key) !== pending) return result;
            iconSnapshots.delete(key);
            iconSnapshots.set(key, {
              snapshot: result,
              expiresAt: Date.now() + ICON_SNAPSHOT_TTL_MS,
            });
            if (iconSnapshots.size > MAX_CACHED_ICON_SNAPSHOTS) {
              const oldest = iconSnapshots.keys().next().value;
              if (oldest !== undefined) iconSnapshots.delete(oldest);
            }
            inFlightSnapshots.delete(key);
            return result;
          },
          () => {
            if (inFlightSnapshots.get(key) === pending) inFlightSnapshots.delete(key);
          },
        );
      }
      // Serve the previous result while refreshing so one slow disk scan does
      // not hold up every project.list request after the TTL expires.
      snapshot = cached?.snapshot ?? (await pending);
    } else {
      snapshot = cached.snapshot;
    }
    this.snapshots.set(project.projectId, snapshot);
    return snapshot;
  }

  async read(project: PersistedProjectRecord): Promise<ProjectIcon | null> {
    return (this.snapshots.get(project.projectId) ?? (await this.snapshot(project))).icon;
  }
}

function invalidateIconSnapshots(paseoHome: string, projectId: string): void {
  const prefix = JSON.stringify([paseoHome, projectId]).slice(0, -1) + ",";
  for (const key of iconSnapshots.keys()) if (key.startsWith(prefix)) iconSnapshots.delete(key);
  for (const key of inFlightSnapshots.keys())
    if (key.startsWith(prefix)) inFlightSnapshots.delete(key);
}

/** Reads the effective icon and gives that exact result a stable identity. */
export async function readProjectIconSnapshot(input: {
  paseoHome: string;
  project: PersistedProjectRecord;
}): Promise<ProjectIconSnapshot> {
  if (input.project.customIconRevision) {
    let icon: ProjectIcon | null = null;
    try {
      icon = validateIcon(await readFile(cachePath(input.paseoHome, input.project.projectId)));
    } catch {
      // A missing/corrupt custom icon is itself a cacheable result until the
      // registry revision changes.
    }
    return {
      icon,
      revision: icon
        ? iconRevision("custom", icon)
        : `custom:none:${input.project.customIconRevision}`,
    };
  }
  const icon = await getProjectIcon(input.project.rootPath);
  if (!icon) return { icon: null, revision: "automatic:none:v1" };
  return { icon, revision: iconRevision("automatic", icon) };
}

function iconRevision(source: "automatic" | "custom", icon: ProjectIcon): string {
  const fingerprint = createHash("sha256")
    .update(icon.mimeType)
    .update("\0")
    .update(icon.data)
    .digest("hex");
  return `${source}:${fingerprint}`;
}

export async function removeProjectCustomIcon(input: {
  paseoHome: string;
  projectId: string;
}): Promise<void> {
  await rm(cachePath(input.paseoHome, input.projectId), { force: true });
}

async function serialize<T>(projectId: string, save: () => Promise<T>): Promise<T> {
  const previous = inFlightSaves.get(projectId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(save);
  inFlightSaves.set(projectId, next);
  try {
    return await next;
  } finally {
    if (inFlightSaves.get(projectId) === next) inFlightSaves.delete(projectId);
  }
}

function cachePath(paseoHome: string, projectId: string): string {
  const key = createHash("sha256").update(projectId).digest("hex");
  return join(paseoHome, "projects", "icons", `${key}.bin`);
}

function detectMimeType(buffer: Buffer): string | null {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  const header = buffer.toString("ascii", 0, 6);
  if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  if (
    buffer.length >= 22 &&
    buffer.readUInt16LE(0) === 0 &&
    buffer.readUInt16LE(2) === 1 &&
    buffer.readUInt16LE(4) > 0
  ) {
    return "image/x-icon";
  }
  return null;
}

function validateIcon(buffer: Buffer): ProjectIcon {
  if (buffer.length === 0 || buffer.length > MAX_ICON_BYTES) {
    throw new Error(ICON_TOO_LARGE_ERROR);
  }
  const mimeType = detectMimeType(buffer);
  if (!mimeType) throw new Error("Unsupported or invalid icon file");
  const size = getImageDimensions(buffer, mimeType);
  if (!size || size.width <= 0 || size.width !== size.height || size.width > 1024) {
    throw new Error("Icon must be a square image up to 1024×1024");
  }
  return { data: buffer.toString("base64"), mimeType };
}
