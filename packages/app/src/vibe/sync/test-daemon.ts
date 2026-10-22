// In-process stand-in for the daemon's `vibe.sync.exchange` (unit tests only): the real
// serveExchange + phone admission policy over an in-memory change store.

import {
  MemoryChangeStore,
  SyncNode,
  phonePolicy,
  serveExchange,
  type ExchangeRequest,
  type JsonValue,
} from "../generated/sync";

export function createFakeDaemon(now: () => number = Date.now) {
  const node = new SyncNode({ deviceId: "daemon", store: new MemoryChangeStore("epoch-1"), now });
  const calls: string[] = [];
  return {
    node,
    calls,
    publish(table: string, rowId: string, values: Record<string, JsonValue>) {
      node.publishFields(table, rowId, values);
    },
    async invoke(method: string, input: unknown): Promise<unknown> {
      calls.push(method);
      if (method !== "vibe.sync.exchange") throw new Error(`unexpected ${method}`);
      return serveExchange(node, input as ExchangeRequest, { policy: phonePolicy });
    },
  };
}

/** A small board as the daemon publishes it (display columns included). */
export function seedBoard(daemon: ReturnType<typeof createFakeDaemon>): void {
  daemon.publish("project", "P1", {
    name: "Alpha",
    prefix: "ALP",
    project_type: "android",
    default_presets_json: "{}",
    concurrency_limit: null,
    devices_json: "[]",
    color: null,
    archived_at: null,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
  });
  daemon.publish("tag", "T1", { name: "bug", evidence: 1, builtin: 1 });
  daemon.publish("tag", "T2", { name: "ui", evidence: 0, builtin: 0 });
  daemon.publish("preset", "PR1", {
    name: "Default",
    provider: "claude",
    model: "sonnet",
    thinking: "",
    permission_mode: "accept-edits",
    environment_kind: "project-default",
    base_branch: null,
    runtime_env: null,
    instructions: "",
    builtin: 1,
  });
  const card = (id: string, number: number, column: string, sortKey: string, title: string) =>
    daemon.publish("card", id, {
      project_id: "P1",
      number,
      key: `ALP-${number}`,
      title,
      description: `about ${title}`,
      column,
      sort_key: sortKey,
      priority: "none",
      acceptance: "",
      ref_images_json: "[]",
      needs_evidence: 0,
      preset_id: null,
      archived_at: null,
      created_at: "2026-10-02T00:00:00.000Z",
    });
  card("C1", 1, "draft", "a", "First idea");
  card("C2", 2, "todo", "b", "Do the thing");
  card("C3", 3, "in_progress", "c", "Running");
  card("C4", 4, "done", "d", "Shipped");
  daemon.node.writeFields("card_tag", "C1:T1", {});
  daemon.node.writeFields("card_tag", "C1:T2", {});
  daemon.publish("agent_session", "S1", {
    card_id: "C3",
    agent_id: "agent-1",
    role: "worker",
    current_provider: "claude",
    switch_history_json: "[]",
    state: "working",
    last_activity_at: "2026-10-03T00:00:00.000Z",
    started_at: "2026-10-03T00:00:00.000Z",
  });
  daemon.publish("card_event", "E1", {
    card_id: "C1",
    type: "note",
    author_kind: "user",
    author: "user",
    created_at: "2026-10-02T01:00:00.000Z",
    body_json: JSON.stringify({ text: "hello" }),
  });
}
