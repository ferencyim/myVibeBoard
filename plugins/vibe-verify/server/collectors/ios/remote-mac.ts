// RemoteMacExecutor: runs commands on a remote macOS host through the system `ssh` / `scp`
// (BatchMode, so it relies on the user's own ~/.ssh/config alias + key; no passwords). Every call
// goes through the injected Runner, so tests assert the exact command lines.

import type { RunResult, Runner } from "../../vibe/contract";

/** POSIX single-quote escaping. */
export function shQuote(value: string): string {
  return "'" + value.split("'").join("'\\''") + "'";
}

const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;
const REMOTE_PATH_RE = /^[A-Za-z0-9_./@+=,-]+$/;

export function assertValidHost(host: string): string {
  // Must not start with "-" (option injection) or contain ":" (breaks scp host:path).
  if (!HOST_RE.test(host)) throw new Error(`Invalid Mac host alias: ${JSON.stringify(host)}`);
  return host;
}

export function assertValidRemotePath(p: string): string {
  if (!REMOTE_PATH_RE.test(p) || p.startsWith("-")) {
    throw new Error(`Unsupported remote path: ${JSON.stringify(p)}`);
  }
  return p;
}

export interface RemoteMacOptions {
  sshPath?: string;
  scpPath?: string;
  connectTimeoutSec?: number;
  signal?: AbortSignal;
}

export interface RemoteCallOptions {
  timeoutMs?: number;
}

export class RemoteMacExecutor {
  readonly host: string;
  private readonly ssh: string;
  private readonly scp: string;
  private readonly baseOpts: string[];

  constructor(
    private readonly runner: Runner,
    host: string,
    private readonly options: RemoteMacOptions = {},
  ) {
    this.host = assertValidHost(host);
    this.ssh = options.sshPath ?? "ssh";
    this.scp = options.scpPath ?? "scp";
    this.baseOpts = [
      "-o",
      "BatchMode=yes",
      "-o",
      `ConnectTimeout=${options.connectTimeoutSec ?? 10}`,
      "-o",
      "ServerAliveInterval=15",
    ];
  }

  /** Runs a shell command string on the Mac (the caller quotes with `shQuote`). */
  shell(command: string, o: RemoteCallOptions = {}): Promise<RunResult> {
    return this.runner.run(this.ssh, [...this.baseOpts, this.host, command], {
      timeoutMs: o.timeoutMs ?? 60_000,
      signal: this.options.signal,
    });
  }

  /** Runs argv on the Mac; every element is shell-quoted. */
  exec(argv: readonly string[], o: RemoteCallOptions = {}): Promise<RunResult> {
    return this.shell(argv.map(shQuote).join(" "), o);
  }

  /** Copies a local file/directory to the Mac. */
  put(local: string, remote: string, o: RemoteCallOptions & { recursive?: boolean } = {}) {
    assertValidRemotePath(remote);
    const args = [...this.baseOpts, ...(o.recursive ? ["-r"] : []), "--", local, `${this.host}:${remote}`];
    return this.runner.run(this.scp, args, {
      timeoutMs: o.timeoutMs ?? 5 * 60_000,
      signal: this.options.signal,
    });
  }

  /** Copies a remote file back to a local path. */
  get(remote: string, local: string, o: RemoteCallOptions = {}) {
    assertValidRemotePath(remote);
    return this.runner.run(this.scp, [...this.baseOpts, "--", `${this.host}:${remote}`, local], {
      timeoutMs: o.timeoutMs ?? 5 * 60_000,
      signal: this.options.signal,
    });
  }
}
