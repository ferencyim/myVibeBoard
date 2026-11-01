/* eslint-disable unicorn/require-post-message-target-origin -- Node Worker, not a browser Window. */
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type { ProviderSubagentDescriptor } from "./provider-subagents/store.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
  AgentTimelineStore,
} from "./agent-timeline-store-types.js";

// SQLite is synchronous, so all database work runs in a dedicated worker. Adjacent writes
// are committed together; replies are sent only after the transaction is durable.
const workerSource = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { mkdirSync } = require('node:fs');
const { dirname } = require('node:path');
const { randomUUID } = require('node:crypto');
const { existsSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
async function start() {
let storePath = workerData.storePath;
if (!existsSync(storePath)) {
  storePath = storePath.replace(/\\.js$/, '.ts');
  const { register } = await import('tsx/esm/api');
  register();
}
const { InMemoryAgentTimelineStore } = await import(pathToFileURL(storePath).href);
mkdirSync(dirname(workerData.filePath), { recursive: true });
const db = new DatabaseSync(workerData.filePath);
db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS timelines (agent_id TEXT PRIMARY KEY, epoch TEXT NOT NULL); CREATE TABLE IF NOT EXISTS timeline_rows (agent_id TEXT NOT NULL, seq INTEGER NOT NULL, row_json TEXT NOT NULL, PRIMARY KEY(agent_id, seq));');
if (!db.prepare('PRAGMA table_info(timelines)').all().some(c => c.name === 'clean')) db.exec('ALTER TABLE timelines ADD COLUMN clean INTEGER NOT NULL DEFAULT 0');
db.exec('CREATE TABLE IF NOT EXISTS subagent_snapshots (agent_id TEXT PRIMARY KEY, data TEXT NOT NULL)');
const dirty = db.prepare('UPDATE timelines SET clean=0 WHERE agent_id=?');
const clean = db.prepare('UPDATE timelines SET clean=1 WHERE agent_id=?');
const ensure = db.prepare('INSERT OR IGNORE INTO timelines(agent_id, epoch) VALUES (?, ?)');
const insert = db.prepare('INSERT INTO timeline_rows(agent_id, seq, row_json) VALUES (?, ?, ?) ON CONFLICT(agent_id, seq) DO UPDATE SET row_json=excluded.row_json');
const queue = [];
let scheduled = false;
function run(m) {
  const a = m.agentId;
  switch (m.op) {
    case 'getSubagents': { const r = db.prepare('SELECT data FROM subagent_snapshots WHERE agent_id=?').get(a); return r ? JSON.parse(r.data) : null; }
    case 'setSubagents': db.prepare('INSERT INTO subagent_snapshots(agent_id,data) VALUES (?,?) ON CONFLICT(agent_id) DO UPDATE SET data=excluded.data').run(a, JSON.stringify(m.descriptors)); return null;
    case 'rows': return db.prepare('SELECT row_json FROM timeline_rows WHERE agent_id=? ORDER BY seq').all(a).map(r => JSON.parse(r.row_json));
    case 'fetch':
    case 'lastItem':
    case 'lastAssistant': {
      const state = db.prepare('SELECT epoch FROM timelines WHERE agent_id=?').get(a);
      const rows = db.prepare('SELECT row_json FROM timeline_rows WHERE agent_id=? ORDER BY seq').all(a).map(r => JSON.parse(r.row_json));
      const memory = new InMemoryAgentTimelineStore();
      memory.initialize(a, { rows, epoch: state?.epoch ?? '' });
      if (m.op === 'lastItem') return memory.getLastItem(a);
      if (m.op === 'lastAssistant') return memory.getLastAssistantMessage(a);
      return memory.fetch(a, m.options);
    }
    case 'isClean': return db.prepare('SELECT clean FROM timelines WHERE agent_id=?').get(a)?.clean === 1;
    case 'markDirty': dirty.run(a); return null;
    case 'markClean': clean.run(a); return null;
    case 'latest': return db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM timeline_rows WHERE agent_id=?').get(a).seq;
    case 'append': {
      ensure.run(a, randomUUID());
      dirty.run(a);
      const seq = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM timeline_rows WHERE agent_id=?').get(a).seq;
      const row = { seq, timestamp: m.timestamp, item: m.item, ...(m.turnId ? { turnId: m.turnId } : {}) };
      insert.run(a, seq, JSON.stringify(row));
      return row;
    }
    case 'insert':
      if (m.rows.length) { ensure.run(a, m.epoch || randomUUID()); dirty.run(a); }
      for (const row of m.rows) insert.run(a, row.seq, JSON.stringify(row));
      return null;
    case 'replace':
      db.prepare('DELETE FROM timeline_rows WHERE agent_id=?').run(a);
      db.prepare('DELETE FROM timelines WHERE agent_id=?').run(a);
      ensure.run(a, m.epoch);
      for (const row of m.rows) insert.run(a, row.seq, JSON.stringify(row));
      return null;
    case 'update': dirty.run(a); db.prepare('UPDATE timeline_rows SET row_json=? WHERE agent_id=? AND seq=?').run(JSON.stringify(m.row), a, m.row.seq); return null;
    case 'delete': db.prepare('DELETE FROM timeline_rows WHERE agent_id=?').run(a); db.prepare('DELETE FROM timelines WHERE agent_id=?').run(a); db.prepare('DELETE FROM subagent_snapshots WHERE agent_id=?').run(a); return null;
  }
}
function drain() {
  scheduled = false;
  const batch = queue.splice(0);
  try {
    db.exec('BEGIN IMMEDIATE');
    const results = batch.map(run);
    db.exec('COMMIT');
    batch.forEach((m, i) => parentPort.postMessage({ id: m.id, result: results[i] }));
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    batch.forEach(m => parentPort.postMessage({ id: m.id, error: String(error) }));
  }
}
parentPort.on('message', m => { queue.push(m); if (!scheduled) { scheduled = true; setImmediate(drain); } });
}
start().catch(error => { throw error; });
`;

export class SqliteAgentTimelineStore implements AgentTimelineStore {
  getSubagentSnapshot(agentId: string): Promise<ProviderSubagentDescriptor[] | null> {
    return this.request("getSubagents", agentId);
  }
  async setSubagentSnapshot(
    agentId: string,
    descriptors: ProviderSubagentDescriptor[],
  ): Promise<void> {
    await this.request("setSubagents", agentId, { descriptors });
  }
  private readonly worker: Worker;
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private failure: Error | undefined;

  constructor(filePath: string) {
    this.worker = new Worker(workerSource, {
      eval: true,
      workerData: {
        filePath,
        storePath: fileURLToPath(new URL("./agent-timeline-store.js", import.meta.url)),
      },
    });
    this.worker.unref();
    this.worker.on("message", (message: { id: number; result?: unknown; error?: string }) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.result);
      if (!this.pending.size) this.worker.unref();
    });
    this.worker.on("error", (error) => this.fail(error));
    this.worker.on("exit", (code) =>
      this.fail(new Error(`Timeline database worker exited (${code})`)),
    );
  }

  private fail(error: Error): void {
    this.failure = error;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  private request<T>(op: string, agentId: string, args: object = {}): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    this.worker.ref();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.worker.postMessage({ id, op, agentId, ...args });
    });
  }

  appendCommitted(
    agentId: string,
    item: AgentTimelineItem,
    options?: { timestamp?: string; turnId?: string },
  ): Promise<AgentTimelineRow> {
    return this.request("append", agentId, {
      item,
      timestamp: options?.timestamp ?? new Date().toISOString(),
      turnId: options?.turnId,
    });
  }

  fetchCommitted(
    agentId: string,
    options?: AgentTimelineFetchOptions,
  ): Promise<AgentTimelineFetchResult> {
    return this.request("fetch", agentId, { options });
  }

  getLatestCommittedSeq(agentId: string): Promise<number> {
    return this.request("latest", agentId);
  }
  getCommittedRows(agentId: string): Promise<AgentTimelineRow[]> {
    return this.request("rows", agentId);
  }
  getLastItem(agentId: string): Promise<AgentTimelineItem | null> {
    return this.request("lastItem", agentId);
  }
  getLastAssistantMessage(agentId: string): Promise<string | null> {
    return this.request("lastAssistant", agentId);
  }
  isClean(agentId: string): Promise<boolean> {
    return this.request("isClean", agentId);
  }
  async markDirty(agentId: string): Promise<void> {
    await this.request("markDirty", agentId);
  }
  async markClean(agentId: string): Promise<void> {
    await this.request("markClean", agentId);
  }
  async deleteAgent(agentId: string): Promise<void> {
    await this.request("delete", agentId);
  }
  async bulkInsert(
    agentId: string,
    rows: readonly AgentTimelineRow[],
    epoch?: string,
  ): Promise<void> {
    await this.request("insert", agentId, { rows, epoch });
  }
  async replaceAgent(
    agentId: string,
    rows: readonly AgentTimelineRow[],
    epoch: string,
  ): Promise<void> {
    await this.request("replace", agentId, { rows, epoch });
  }
  async updateCommittedRow(agentId: string, row: AgentTimelineRow): Promise<void> {
    await this.request("update", agentId, { row });
  }
  async close(): Promise<void> {
    await this.worker.terminate();
  }
}
