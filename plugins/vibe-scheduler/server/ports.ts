// Dev-server port allocation: one stable port per key (card id), never shared between two live keys
// and verified free on the machine at allocation time. The map is persisted so a scheduler restart
// does not hand a worker's port to somebody else.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname } from "node:path";

export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

export interface PortAllocatorOptions {
  /** JSON file; omit for memory only. */
  file?: string;
  base: number;
  span: number;
  isFree?: (port: number) => Promise<boolean>;
}

export function createPortAllocator(options: PortAllocatorOptions) {
  const isFree = options.isFree ?? isPortFree;
  const map = new Map<string, number>();
  if (options.file && existsSync(options.file)) {
    try {
      const raw = JSON.parse(readFileSync(options.file, "utf8")) as Record<string, number>;
      for (const [k, v] of Object.entries(raw)) if (Number.isInteger(v)) map.set(k, v);
    } catch {
      // A corrupt file just means ports are re-allocated.
    }
  }
  const save = () => {
    if (!options.file) return;
    mkdirSync(dirname(options.file), { recursive: true });
    writeFileSync(options.file, JSON.stringify(Object.fromEntries(map), null, 2));
  };

  return {
    get: (key: string) => map.get(key),
    all: () => Object.fromEntries(map),
    async allocate(key: string): Promise<number> {
      const existing = map.get(key);
      if (existing !== undefined) return existing;
      const used = new Set(map.values());
      for (let i = 0; i < options.span; i++) {
        const port = options.base + i;
        if (used.has(port) || !(await isFree(port))) continue;
        map.set(key, port);
        save();
        return port;
      }
      throw new Error(`No free dev-server port in ${options.base}-${options.base + options.span - 1}`);
    },
    release(key: string): void {
      if (map.delete(key)) save();
    },
    keys: () => [...map.keys()],
  };
}

export type PortAllocator = ReturnType<typeof createPortAllocator>;
