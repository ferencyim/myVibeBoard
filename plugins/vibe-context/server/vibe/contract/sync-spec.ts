// GENERATED FROM plugins/vibe-shared — DO NOT EDIT (run: node scripts/vibe/sync-shared.mjs)
// Which tables sync, in which direction, and which columns carry field-level LWW metadata.
// Consumed by the command layer (to stamp HLCs) and later by WP-13 / WP-41 / WP-40.
//
//   both  - bidirectional; every listed column has an entry in sync_meta (field-level LWW),
//           rows are deleted via sync_tombstone.
//   down  - daemon -> phone snapshot + increments only.
//   local - never leaves the computer.

export type SyncDirection = "both" | "down" | "local";

export interface SyncTableSpec {
  table: string;
  direction: SyncDirection;
  /** Primary key columns; the sync row id is these values joined with ":". */
  pk: readonly string[];
  /** Columns merged field by field (direction=both only). */
  fields: readonly string[];
}

const both = (table: string, pk: readonly string[], fields: readonly string[]): SyncTableSpec => ({
  table,
  direction: "both",
  pk,
  fields,
});
const down = (table: string, pk: readonly string[]): SyncTableSpec => ({
  table,
  direction: "down",
  pk,
  fields: [],
});
const local = (table: string, pk: readonly string[]): SyncTableSpec => ({
  table,
  direction: "local",
  pk,
  fields: [],
});

export const SYNC_TABLES: readonly SyncTableSpec[] = [
  both(
    "project",
    ["id"],
    [
      "name",
      "project_type", // COMPAT(project-types): added 2026-10-21, remove after 2027-04-01
      "project_types_json",
      "description",
      "requirements_path",
      "default_preset_id",
      "concurrency_limit",
      "devices_json",
      "color",
      "archived_at",
    ],
  ),
  both(
    "card",
    ["id"],
    [
      "project_id",
      "title",
      "description",
      "column",
      "sort_key",
      "priority",
      "acceptance",
      "ref_images_json",
      "needs_evidence",
      "preset_id",
      "suggested_preset_id",
      "reviewer_preset_id",
      "parent_card_id",
      "archived_at",
    ],
  ),
  both("card_event", ["id"], ["card_id", "type", "author_kind", "author", "created_at", "body_json"]),
  both(
    "preset",
    ["id"],
    [
      "name",
      "provider",
      "model",
      "thinking",
      "permission_mode",
      "environment_kind",
      "base_branch",
      "runtime_env",
      "instructions",
      "fallback_preset_ids_json",
      "role_hint", // COMPAT(preset-role-hints): added 2026-10-21, remove after 2027-04-01
      "role_hints_json",
    ],
  ),
  both("tag", ["id"], ["name", "evidence"]),
  both("card_tag", ["card_id", "tag_id"], []),
  both(
    "maintenance_rule",
    ["id"],
    [
      "name",
      "trigger_kind",
      "trigger_json",
      "check_json",
      "agent",
      "output_mode",
      "priority",
      "dedupe_key",
      "daily_cap",
      "enabled",
      "paused_at",
    ],
  ),
  // Prompt overrides (WP-98): the phone may edit the text; scope and key are the row id.
  both("prompt_override", ["id"], ["text"]),
  down("prompt_template", ["key"]),
  down("agent_session", ["id"]),
  down("plan_version", ["id"]),
  down("git_snapshot", ["project_id"]),
  down("verification", ["id"]),
  down("verification_item", ["id"]),
  down("evidence_file", ["id"]),
  down("maintenance_run", ["id"]),
  local("attachment", ["id"]),
  local("usage_event", ["id"]),
  local("resource_sample", ["id"]),
  local("device", ["id"]),
  local("device_lease", ["id"]),
  local("vibe_event", ["seq"]),
];

export function syncSpec(table: string): SyncTableSpec | undefined {
  return SYNC_TABLES.find((s) => s.table === table);
}
