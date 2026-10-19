import {
  ClientSync,
  MemoryChangeStore,
  SyncNode,
  serveExchange,
  type ExchangeRequest,
  type ExchangeResponse,
  type ExchangeTransport,
} from "../sync";

/** Deterministic PRNG (mulberry32) in [0,1). */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const T0 = 1_700_000_000_000;

/** Simulated world: one shared "real" time, a daemon (authoritative) and phones with skewed clocks. */
export class World {
  t = T0;
  readonly server: SyncNode;
  readonly phones: ClientSync[] = [];

  constructor(public maxDriftMs?: number) {
    this.server = new SyncNode({
      deviceId: "daemon",
      store: new MemoryChangeStore("epoch-1"),
      now: () => this.t,
      maxDriftMs: this.maxDriftMs,
    });
  }

  addPhone(id: string, skewMs = 0): ClientSync {
    const p = new ClientSync({
      deviceId: id,
      store: new MemoryChangeStore(),
      now: () => this.t + skewMs,
      maxDriftMs: this.maxDriftMs,
    });
    this.phones.push(p);
    return p;
  }

  /** Direct, reliable transport to the server. */
  transport: ExchangeTransport = async (req) => serveExchange(this.server, req);

  syncAll(): Promise<unknown> {
    return Promise.all(this.phones.map((p) => p.sync(this.transport)));
  }
}

export type { ExchangeRequest, ExchangeResponse };
