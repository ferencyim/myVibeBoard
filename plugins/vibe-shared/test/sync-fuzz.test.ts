// Fuzz: random offline periods, concurrent edits, clock drift (+-1h), duplicated / lost / replayed
// exchanges. After healing, every replica must hold exactly the same state (convergence) and no
// accepted write may be lost (the field value is the one with the greatest HLC).

import { describe, expect, it } from "vitest";
import { compareHlc } from "../contract/hlc";
import {
  MemoryChangeStore,
  applyChange,
  changeKey,
  generateSortKey,
  needsRebalance,
  serveExchange,
  snapshotState,
  type Change,
  type ClientSync,
  type ExchangeRequest,
  type JsonValue,
} from "../sync";
import { World, makeRng } from "./sync-helpers";

const HOUR = 3_600_000;
const TABLES = ["card", "card_tag", "agent_session"] as const;
const TAGS = ["t1", "t2", "t3"];
const SEEDS = Number(process.env.VIBE_FUZZ_SEEDS ?? 60);
const STEPS = Number(process.env.VIBE_FUZZ_STEPS ?? 350);

interface Written {
  hlc: string;
  value: JsonValue;
}

function runWorld(seed: number, mode: "free" | "contended") {
  const rnd = makeRng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const w = new World();
  const phones = [0, 1, 2].map((i) => w.addPhone(`phone-${i}`, Math.round((rnd() * 2 - 1) * HOUR)));
  const online = phones.map(() => false);
  const oldRequests: ExchangeRequest[] = [];
  const known: string[] = []; // card ids that exist somewhere
  const written = new Map<string, Written>(); // fieldKey -> greatest-HLC write ever made
  const deleted = new Set<string>();
  const daemonMoved = new Set<string>();
  let nextCard = 0;

  const record = (table: string, rowId: string, col: string, hlc: string, value: JsonValue) => {
    const k = `${table}/${rowId}/${col}`;
    const cur = written.get(k);
    if (!cur || compareHlc(hlc, cur.hlc) > 0) written.set(k, { hlc, value });
  };

  const phoneWrite = (p: ClientSync, id: string, values: Record<string, JsonValue>) => {
    p.write("card", id, values);
    for (const col of Object.keys(values)) {
      const f = p.node.store.getField("card", id, col);
      if (f) record("card", id, col, f.hlc, f.value);
    }
  };

  const orderedKeys = (p: ClientSync) =>
    p.node
      .listRows("card")
      .map((r) => r.values.sort_key as string)
      .filter(Boolean)
      .sort();

  const phoneOp = (p: ClientSync) => {
    const op = rnd();
    if (op < 0.2 || known.length === 0) {
      const id = `card-${nextCard++}`;
      known.push(id);
      const keys = orderedKeys(p);
      phoneWrite(p, id, {
        title: `new-${id}-${p.node.deviceId}`,
        column: pick(["draft", "todo"]),
        sort_key: generateSortKey(keys[keys.length - 1] ?? null, null, { random: rnd }),
      });
      return;
    }
    const id = pick(known);
    if (deleted.has(id) || !p.node.readRow("card", id)) {
      // not visible on this phone yet (or deleted): edit anyway - stale edits must be harmless
      if (rnd() < 0.5) return;
    }
    if (op < 0.45) phoneWrite(p, id, { title: `t-${Math.floor(rnd() * 1e6)}` });
    else if (op < 0.55) phoneWrite(p, id, { description: `d-${Math.floor(rnd() * 1e6)}`, priority: Math.floor(rnd() * 4) });
    else if (op < 0.7) phoneWrite(p, id, { column: pick(["draft", "todo"]) });
    else if (op < 0.85) {
      const keys = orderedKeys(p);
      const i = Math.floor(rnd() * (keys.length + 1));
      let k = generateSortKey(keys[i - 1] ?? null, keys[i] ?? null, { random: rnd });
      if (needsRebalance(k)) k = generateSortKey(null, null, { random: rnd });
      phoneWrite(p, id, { sort_key: k });
    } else if (op < 0.95) {
      const row = `${id}:${pick(TAGS)}`;
      if (rnd() < 0.5) p.write("card_tag", row, {});
      else p.remove("card_tag", row);
    } else if (mode === "contended") {
      p.remove("card", id);
      deleted.add(id); // may be rejected; only used to filter the "no loss" oracle
    }
  };

  const daemonOp = () => {
    if (known.length === 0) return;
    const id = pick(known);
    if (rnd() < 0.5) {
      const col = pick(["in_progress", "verifying", "done"]);
      const cur = w.server.readRow("card", id);
      if (!cur) return;
      w.server.writeFields("card", id, { column: col });
      daemonMoved.add(id);
    } else {
      w.server.publishFields("agent_session", `s-${id}`, { state: pick(["running", "waiting", "done"]), card_id: id });
    }
  };

  const exchange = async (idx: number) => {
    const p = phones[idx] as ClientSync;
    const fate = rnd();
    let delivered = 0;
    const transport = async (req: ExchangeRequest) => {
      oldRequests.push(req);
      const resp = serveExchange(w.server, req);
      delivered++;
      if (fate < 0.15) serveExchange(w.server, req); // duplicate delivery
      if (fate > 0.85 && delivered === 1) throw new Error("response lost"); // applied, answer dropped
      return resp;
    };
    try {
      await p.sync(transport, { limit: 1 + Math.floor(rnd() * 40) });
    } catch {
      // network error: outbox stays, retried later
    }
    if (rnd() < 0.3 && oldRequests.length) serveExchange(w.server, pick(oldRequests)); // late, reordered replay
  };

  const run = async () => {
    for (let step = 0; step < STEPS; step++) {
      w.t += rnd() < 0.3 ? 0 : Math.floor(rnd() * 4000);
      const r = rnd();
      if (r < 0.55) phoneOp(pick(phones));
      else if (r < 0.7 && mode === "contended") daemonOp();
      else if (r < 0.75) {
        const i = Math.floor(rnd() * phones.length);
        online[i] = !online[i];
      } else {
        const i = Math.floor(rnd() * phones.length);
        if (online[i]) await exchange(i);
      }
    }
    // heal: everyone online, perfect network, until quiescent
    for (let round = 0; round < 3; round++) await w.syncAll();
  };

  return { w, phones, run, written, deleted, daemonMoved };
}

describe("fuzz: replicas converge, nothing is lost", () => {
  for (const mode of ["free", "contended"] as const) {
    it(`${SEEDS} random worlds (${mode})`, async () => {
      for (let seed = 1; seed <= SEEDS; seed++) {
        const { w, phones, written, deleted, daemonMoved } = await runWorldAndHeal(seed, mode);
        const ref = snapshotState(w.server.store, [...TABLES]);
        for (const p of phones) {
          expect(snapshotState(p.node.store, [...TABLES]), `seed ${seed} ${mode} phone ${p.node.deviceId}`).toBe(ref);
          expect(p.pending, `seed ${seed} outbox drained`).toEqual([]);
        }
        if (mode === "free") {
          // zero loss: the surviving value of every field is the greatest-HLC write ever made
          for (const [key, win] of written) {
            const [table, rowId, col] = key.split("/") as [string, string, string];
            const f = w.server.store.getField(table, rowId, col);
            expect(f?.value, `seed ${seed} ${key}`).toEqual(win.value);
            expect(f?.hlc, `seed ${seed} ${key}`).toBe(win.hlc);
          }
        } else {
          // the daemon's column decisions are never reverted by a phone
          for (const id of daemonMoved) {
            const row = w.server.readRow("card", id);
            if (row) expect(["in_progress", "verifying", "done"], `seed ${seed} ${id}`).toContain(row.values.column);
          }
          // deleted rows are gone everywhere or (when the delete was refused) alive everywhere
          for (const id of deleted) {
            const alive = !!w.server.readRow("card", id);
            for (const p of phones) expect(!!p.node.readRow("card", id)).toBe(alive);
          }
        }
      }
    });
  }
});

async function runWorldAndHeal(seed: number, mode: "free" | "contended") {
  const world = runWorld(seed, mode);
  await world.run();
  return world;
}

describe("fuzz: raw change streams are commutative, associative and idempotent", () => {
  it("any order, any duplication, any batching gives the same state", () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rnd = makeRng(1000 + seed);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
      const hlcOf = (wall: number, counter: number, node: string) =>
        `${wall.toString(16).padStart(12, "0")}-${counter.toString(16).padStart(4, "0")}-${node}`;
      const changes: Change[] = [];
      for (let i = 0; i < 150; i++) {
        const node = pick(["a", "b", "c"]);
        const hlc = hlcOf(1_000_000 + Math.floor(rnd() * 40), Math.floor(rnd() * 3), node);
        const rowId = pick(["r1", "r2", "r3"]);
        if (rnd() < 0.1) changes.push({ kind: "delete", table: "card", rowId, hlc });
        else if (rnd() < 0.2) {
          const t = pick(["t1", "t2"]);
          if (rnd() < 0.5) changes.push({ kind: "delete", table: "card_tag", rowId: `${rowId}:${t}`, hlc });
          else changes.push({ kind: "field", table: "card_tag", rowId: `${rowId}:${t}`, column: "__row", value: true, hlc });
        } else {
          const column = pick(["title", "description", "priority"]);
          changes.push({ kind: "field", table: "card", rowId, column, value: `${node}${i}`, hlc });
        }
      }
      // same-key same-hlc must carry the same value (one write has one identity)
      const seen = new Map<string, Change>();
      const unique = changes.filter((c) => {
        const id = changeKey(c) + c.hlc;
        if (seen.has(id)) return false;
        seen.set(id, c);
        return true;
      });
      const states = [0, 1, 2, 3].map((variant) => {
        const store = new MemoryChangeStore();
        let order = [...unique];
        if (variant > 0) order.sort(() => rnd() - 0.5);
        if (variant === 3) order = [...order, ...order.filter(() => rnd() < 0.5)]; // duplicates
        // intermediate "sync" through changesSince must not alter the outcome
        const mid = new MemoryChangeStore();
        for (const c of order) {
          applyChange(store, c);
          if (variant === 2) applyChange(mid, c);
        }
        if (variant === 2) {
          const copy = new MemoryChangeStore();
          for (const c of mid.changesSince(0).changes) applyChange(copy, c);
          return snapshotState(copy, ["card", "card_tag"]);
        }
        return snapshotState(store, ["card", "card_tag"]);
      });
      expect(new Set(states).size, `seed ${seed}`).toBe(1);
    }
  });
});
