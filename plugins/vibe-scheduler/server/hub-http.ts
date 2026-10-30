// Local HTTP API of the hub (docs/vibe/HUB-DESIGN.md 2.2): 127.0.0.1, random port, Bearer token.
// The port and token go to hub.json so win-heavy-guard can find the hub; the file is removed on stop.

import { execFileSync } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { z } from "zod";
import type { Hub } from "./hub";

const JobBody = z.object({
  owner: z.string().min(1).max(200),
  project: z.string().max(200).optional(),
  command: z.string().min(1).max(20000),
  commandSha256: z.string().min(1).max(128),
  priority: z.number().int().min(0).max(9),
  exclusive: z.boolean().default(false),
  slots: z.number().int().min(1).max(64).default(1),
  memGb: z.number().min(0).max(1024).optional(),
  resources: z
    .array(z.object({ name: z.string().min(1).max(200), mode: z.enum(["shared", "exclusive"]) }))
    .max(16)
    .optional(),
  pid: z.number().int().min(1),
});
const ReleaseBody = z.object({
  exitCode: z.number().int().optional(),
  durationMs: z.number().min(0).optional(),
});

export interface HubHttpOptions {
  /** Directory that holds hub.json. */
  dir: string;
  onError?: (error: unknown) => void;
}

function send(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > 64 * 1024) throw Object.assign(new Error("请求体过大"), { status: 413 });
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("请求体不是有效 JSON"), { status: 400 });
  }
}

/** Best effort: only the current user may read hub.json (the token is in it). */
function restrictToCurrentUser(file: string) {
  if (process.platform !== "win32") {
    chmodSync(file, 0o600);
    return;
  }
  const user = process.env.USERNAME;
  if (!user) return;
  execFileSync("icacls", [file, "/inheritance:r", "/grant:r", `${user}:F`], {
    windowsHide: true,
    timeout: 5000,
    stdio: "ignore",
  });
}

export async function startHubHttp(hub: Hub, options: HubHttpOptions) {
  const token = randomBytes(24).toString("hex");
  const expected = Buffer.from("Bearer " + token);
  const file = join(options.dir, "hub.json");

  const authorized = (req: IncomingMessage) => {
    const got = Buffer.from(req.headers.authorization ?? "");
    return got.length === expected.length && timingSafeEqual(got, expected);
  };

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "v1") return send(res, 404, { error: "not found" });

    if (req.method === "GET" && parts[1] === "status" && parts.length === 2)
      return send(res, 200, await hub.status());

    if (parts[1] !== "jobs") return send(res, 404, { error: "not found" });

    if (req.method === "POST" && parts.length === 2) {
      const body = JobBody.safeParse(await readJson(req));
      if (!body.success)
        return send(res, 400, { error: body.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ") });
      return send(res, 200, await hub.submit(body.data));
    }

    const id = parts[2];
    if (!id) return send(res, 404, { error: "not found" });
    const gone = () => send(res, 410, { error: "任务不存在或已被回收" });

    if (req.method === "GET" && parts.length === 3) {
      const wait = Number(url.searchParams.get("wait") ?? 0);
      const result = await hub.wait(id, Number.isFinite(wait) ? wait : 0);
      return result ? send(res, 200, result) : gone();
    }
    if (req.method === "POST" && parts[3] === "heartbeat")
      return send(res, 200, hub.heartbeat(id) === "ok" ? { ok: true } : { ok: false, gone: true });
    if (req.method === "POST" && parts[3] === "release") {
      const body = ReleaseBody.safeParse(await readJson(req));
      if (!body.success) return send(res, 400, { error: "exitCode / durationMs 无效" });
      return send(res, 200, (await hub.release(id, body.data)) ? { ok: true } : { ok: false, gone: true });
    }
    return send(res, 404, { error: "not found" });
  }

  const server: Server = createServer((req, res) => {
    if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
    route(req, res).catch((error: unknown) => {
      const status = (error as { status?: number }).status ?? 500;
      if (status === 500) options.onError?.(error);
      if (!res.headersSent) send(res, status, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as { port: number }).port;

  const info = { port, token, pid: process.pid, startedAt: new Date().toISOString() };
  mkdirSync(options.dir, { recursive: true });
  const tmp = file + "." + process.pid + ".tmp";
  writeFileSync(tmp, JSON.stringify(info, null, 2) + "\n");
  try {
    restrictToCurrentUser(tmp);
  } catch (error) {
    options.onError?.(error);
  }
  renameSync(tmp, file);

  return {
    port,
    token,
    file,
    async stop() {
      // Only remove a hub.json that is still ours (another daemon may have replaced it).
      try {
        const current = JSON.parse(readFileSync(file, "utf8")) as { token?: string };
        if (current.token === token) rmSync(file, { force: true });
      } catch {
        // already gone
      }
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
export type HubHttp = Awaited<ReturnType<typeof startHubHttp>>;
