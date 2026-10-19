import type { ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ndJsonStream, type AnyMessage } from "@agentclientprotocol/sdk";
import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import type {
  AcpStream,
  AcpStreamMessage,
} from "@getpaseo/plugin/server/acp";
import type {
  ProviderLaunch,
  ProviderStatus,
} from "@getpaseo/plugin/server/provider";

// Minimum only, like the Paseo requirements range: newer DSH releases are
// accepted, and ACP behaviour is chosen from the capabilities DSH advertises.
// Add an exclusion only for a release known to be incompatible.
export const MINIMUM_DSH_VERSION = "0.1.5-rc.1";

const VERSION_PROBE_TIMEOUT_MS = 5_000;
const STARTUP_TIMEOUT_MS = 5_000;
const SHUTDOWN_SIGNAL_TIMEOUT_MS = 1_000;
const DIAGNOSTIC_LIMIT = 1_600;
const STDERR_CAPTURE_LIMIT = 8_192;
const ANSI_ESCAPE_RE = new RegExp(
  String.fromCharCode(27) + "\\[[0-?]*[ -/]*[@-~]",
  "g",
);

export interface ConnectorResource {
  close(reason?: unknown): Promise<void>;
}

export interface DshConnectorContext {
  /** Executable, argument prefix and complete environment resolved by the daemon. */
  launch: ProviderLaunch;
  cwd: string;
  /** Session variables, applied over the launch environment. */
  env: Readonly<Record<string, string>>;
  resources: Set<ConnectorResource>;
  isClosed?: () => boolean;
}

export interface AcpStreamOwner {
  close(reason?: unknown): Promise<void>;
  onFailure(listener: (error: Error) => void): () => void;
}

export interface ManagedAcpStream extends AcpStream {
  close(reason?: unknown): Promise<void>;
  fail(error: unknown): void;
}

type ProtocolState =
  | "awaiting-initialize"
  | "awaiting-initialize-response"
  | "initialized"
  | "closed";

type PersistenceMode = "none" | "resume" | "native-load";

interface RecordValue {
  [key: string]: unknown;
}

export function assertSupportedNodeVersion(version = process.versions.node): void {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) {
    throw new Error(
      "DeepSeek Harness requires Node.js 22.19.0 or newer; the daemon runtime reported " +
        version,
    );
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (
    major < 22 ||
    (major === 22 && (minor < 19 || (minor === 19 && patch < 0)))
  ) {
    throw new Error(
      "DeepSeek Harness requires Node.js 22.19.0 or newer; the daemon runtime reported " +
        version,
    );
  }
}

export function extractDshVersion(output: string): string | undefined {
  // Keep prerelease and build metadata so diagnostics show the exact version.
  return /(?:^|[^0-9A-Za-z.+_-])([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)(?=$|[^0-9A-Za-z.+_-])/.exec(
    output,
  )?.[1];
}

export function isSupportedDshVersion(version: string | undefined): boolean {
  if (version === undefined) return false;
  const parsed = parseSemver(version);
  const minimum = parseSemver(MINIMUM_DSH_VERSION);
  return parsed !== undefined && minimum !== undefined && compareSemver(parsed, minimum) >= 0;
}

interface Semver {
  core: [number, number, number];
  prerelease: string[];
}

function parseSemver(version: string): Semver | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  if (!match) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split(".") ?? [],
  };
}

/** Semantic Versioning 2.0 precedence; build metadata is ignored. */
function compareSemver(a: Semver, b: Semver): number {
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i];
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return b.prerelease.length - a.prerelease.length;
  }
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return Number(x) - Number(y);
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function redactDiagnostic(value: string): string {
  return value
    .replace(ANSI_ESCAPE_RE, "")
    .replace(
      // Accept JSON/log key quotes and the common "API key" spelling.
      // Consume escaped quotes too, rather than leaking the rest of a value.
      /(["']?(?:api[ _-]?key|authorization|bearer|token|secret|password|cookie)["']?\s*[:=]\s*)(?:Bearer\s+)?(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[^\s,;]+)/gi,
      "$1[redacted]",
    )
    .replace(/(Bearer\s+)[^\s]+/gi, "$1[redacted]")
    .trim()
    .slice(0, DIAGNOSTIC_LIMIT);
}

export async function createDshAcpStream(
  context: DshConnectorContext,
): Promise<ManagedAcpStream> {
  assertSupportedNodeVersion();
  assertConnectorOpen(context, "before starting");

  const env = { ...context.launch.env, ...context.env };
  const cwd = context.cwd || process.cwd();
  const { command, args } = context.launch;

  await probeDshVersion(context.launch, cwd, env, context);
  assertConnectorOpen(context, "after version probe");

  const child = spawnProcess(command, [...args], {
    cwd,
    env,
    stdio: "pipe",
  });
  const stderr = new BoundedCapture(STDERR_CAPTURE_LIMIT);
  const owner = new ChildProcessOwner(child, command, () => stderr.value);
  if (!child.stdin || !child.stdout || !child.stderr) {
    const startupError = new Error(
      "DeepSeek Harness ACP could not acquire piped stdio for executable " +
        command,
    );
    await owner.close(startupError).catch(() => undefined);
    throw startupError;
  }

  child.stderr.on("data", (chunk: unknown) => stderr.append(chunk));

  const raw = ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout),
  ) as unknown as AcpStream;
  let resource: ConnectorResource | undefined;
  const managed = createAcpCompatibilityStream(raw, owner, () => {
    if (resource) {
      context.resources.delete(resource);
    }
  });
  resource = {
    close: (reason) => managed.close(reason),
  };

  try {
    await registerConnectorResource(context, resource, "ACP startup");
    await waitForChildSpawn(child);
    if (owner.hasExited) {
      throw new Error(
        "DeepSeek Harness ACP exited during startup." +
          diagnosticSuffix(stderr.value),
      );
    }
    return managed;
  } catch (error) {
    const startupError = new Error(
      "DeepSeek Harness ACP failed to start " +
        command +
        "." +
        diagnosticSuffix(stderr.value),
      );
    await managed.close(startupError).catch(() => undefined);
    throw new Error(startupError.message, { cause: error });
  }
}

export function createAcpCompatibilityStream(
  source: AcpStream,
  owner: AcpStreamOwner,
  onClosed: () => void = () => undefined,
): ManagedAcpStream {
  const reader = source.readable.getReader();
  const writer = source.writable.getWriter();

  let state: ProtocolState = "awaiting-initialize";
  let persistenceMode: PersistenceMode = "none";
  let initializeId: string | number | null | undefined;
  let readableController:
    | ReadableStreamDefaultController<AcpStreamMessage>
    | undefined;
  let failed = false;
  let closePromise: Promise<void> | undefined;

  const unsubscribeFailure = owner.onFailure((error) => {
    fail(error);
  });

  const close = (reason?: unknown): Promise<void> => {
    if (closePromise) {
      return closePromise;
    }
    state = "closed";
    closePromise = (async () => {
      const results = await Promise.allSettled([
        reader.cancel(reason),
        writer.abort(reason),
        owner.close(reason),
      ]);
      unsubscribeFailure();
      onClosed();

      const ownerResult = results[2];
      if (ownerResult.status === "rejected") {
        throw asError(ownerResult.reason);
      }
    })();
    return closePromise;
  };

  function fail(error: unknown): void {
    if (state === "closed") {
      return;
    }
    failed = true;
    state = "closed";
    const normalized = asError(error);
    try {
      readableController?.error(normalized);
    } catch {
      // The stream may already have been terminated by its consumer.
    }
    void close(normalized).catch(() => undefined);
  }

  const readable = new ReadableStream<AcpStreamMessage>({
    start(controller) {
      readableController = controller;
    },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          await close(new Error("DeepSeek Harness ACP stdio reached EOF"));
          if (!failed) {
            controller.close();
          }
          return;
        }

        const message = assertAcpStreamMessage(next.value as AnyMessage);
        controller.enqueue(transformInbound(message));
      } catch (error) {
        fail(error);
      }
    },
    cancel(reason) {
      return close(reason);
    },
  });

  const writable = new WritableStream<AcpStreamMessage>({
    async write(input) {
      try {
        const message = assertAcpStreamMessage(input);
        await writer.write(transformOutbound(message));
      } catch (error) {
        fail(error);
        throw error;
      }
    },
    close() {
      return close(new Error("DeepSeek Harness ACP stdio writable closed"));
    },
    abort(reason) {
      return close(reason);
    },
  });

  return {
    readable,
    writable,
    close,
    fail,
  };

  function transformOutbound(message: AcpStreamMessage): AcpStreamMessage {
    if (state === "closed") {
      throw new Error("DeepSeek Harness ACP stream is closed");
    }

    if (state === "awaiting-initialize") {
      if (!isRequestFrame(message) || message.method !== "initialize") {
        throw new Error(
          "DeepSeek Harness ACP received a non-initialize frame before initialization",
        );
      }
      initializeId = message.id;
      state = "awaiting-initialize-response";
      return message;
    }

    if (state === "awaiting-initialize-response") {
      throw new Error(
        "DeepSeek Harness ACP received an outbound frame before initialize completed",
      );
    }

    const messageRecord = message as unknown as RecordValue;
    if (messageRecord.method === "initialize") {
      throw new Error(
        "DeepSeek Harness ACP received a duplicate initialize request",
      );
    }

    if (messageRecord.method !== "session/load") {
      return message;
    }

    if (persistenceMode === "native-load") {
      return message;
    }
    if (persistenceMode !== "resume") {
      throw new Error(
        "DeepSeek Harness ACP cannot translate session/load because the peer did not advertise session/resume",
      );
    }
    if (
      !isRequestFrame(message) ||
      !isLoadSessionParams(messageRecord.params)
    ) {
      throw new Error(
        "DeepSeek Harness ACP received an invalid session/load request",
      );
    }

    return {
      ...message,
      method: "session/resume",
    } as AcpStreamMessage;
  }

  function transformInbound(message: AcpStreamMessage): AcpStreamMessage {
    if (state === "awaiting-initialize-response") {
      if (!isResponseFrame(message) || message.id !== initializeId) {
        throw new Error(
          "DeepSeek Harness ACP received an unexpected frame while waiting for initialize",
        );
      }

      state = "initialized";
      if (hasOwn(message, "error")) {
        return message;
      }
      return projectInitializeCapabilities(message);
    }

    if (state === "awaiting-initialize") {
      throw new Error(
        "DeepSeek Harness ACP received a frame before the initialize request",
      );
    }
    if (state === "closed") {
      throw new Error("DeepSeek Harness ACP stream is closed");
    }

    return projectToolOutput(projectThoughtMessageId(message));
  }

  function projectInitializeCapabilities(
    message: AcpStreamMessage,
  ): AcpStreamMessage {
    const messageRecord = message as unknown as RecordValue;
    if (!isRecord(messageRecord.result)) {
      throw new Error(
        "DeepSeek Harness ACP initialize succeeded without an object result",
      );
    }

    const result = messageRecord.result;
    const capabilitiesValue = result.agentCapabilities;
    if (capabilitiesValue === undefined) {
      persistenceMode = "none";
      return message;
    }
    if (!isRecord(capabilitiesValue)) {
      throw new Error(
        "DeepSeek Harness ACP initialize returned invalid agentCapabilities",
      );
    }

    const hasLoad = validateLoadCapability(capabilitiesValue);
    const sessionCapabilitiesValue = capabilitiesValue.sessionCapabilities;
    if (
      sessionCapabilitiesValue !== undefined &&
      sessionCapabilitiesValue !== null &&
      !isRecord(sessionCapabilitiesValue)
    ) {
      throw new Error(
        "DeepSeek Harness ACP initialize returned invalid sessionCapabilities",
      );
    }

    const resumeValue =
      isRecord(sessionCapabilitiesValue) &&
      hasOwn(sessionCapabilitiesValue, "resume")
        ? sessionCapabilitiesValue.resume
        : undefined;
    if (
      resumeValue !== undefined &&
      resumeValue !== null &&
      !isRecord(resumeValue)
    ) {
      throw new Error(
        "DeepSeek Harness ACP initialize returned invalid session/resume capability",
      );
    }

    if (hasLoad) {
      persistenceMode = "native-load";
      return message;
    }
    if (isRecord(resumeValue)) {
      persistenceMode = "resume";
      return {
        ...message,
        result: {
          ...result,
          agentCapabilities: {
            ...capabilitiesValue,
            loadSession: true,
          },
        },
      } as AcpStreamMessage;
    }

    persistenceMode = "none";
    return message;
  }
}

function projectThoughtMessageId(message: AcpStreamMessage): AcpStreamMessage {
  const params = (message as unknown as RecordValue).params;
  if (
    !isNotificationFrame(message) ||
    message.method !== "session/update" ||
    !isRecord(params) ||
    !isRecord(params.update)
  ) {
    return message;
  }
  const update = params.update;
  if (
    update.sessionUpdate !== "agent_thought_chunk" ||
    typeof update.messageId !== "string" ||
    update.messageId.length === 0
  ) {
    return message;
  }

  // dsh-acp sends a message's thought and answer chunks with one messageId;
  // ACP treats that as one message, so Paseo merges the two buffers. Remove
  // once DSH sends distinct IDs:
  // https://github.com/deepseek-ai/deepseek-harness/discussions/8235
  // ACP IDs are strings, not UUID-only. Keep the answer's native ID untouched.
  return {
    ...message,
    params: {
      ...params,
      update: { ...update, messageId: update.messageId + ":thought" },
    },
  } as AcpStreamMessage;
}

function projectToolOutput(message: AcpStreamMessage): AcpStreamMessage {
  const messageRecord = message as unknown as RecordValue;
  const paramsValue = messageRecord.params;
  if (
    !isNotificationFrame(message) ||
    messageRecord.method !== "session/update" ||
    !isRecord(paramsValue) ||
    !isRecord(paramsValue.update)
  ) {
    return message;
  }

  const params = paramsValue;
  const updateValue = params.update;
  if (!isRecord(updateValue)) {
    return message;
  }
  const update = updateValue;
  if (
    update.sessionUpdate !== "tool_call" &&
    update.sessionUpdate !== "tool_call_update"
  ) {
    return message;
  }
  if (!Array.isArray(update.content)) {
    return message;
  }
  if (hasOwn(update, "rawOutput") && update.rawOutput !== undefined) {
    return message;
  }

  return {
    ...message,
    params: {
      ...params,
      update: {
        ...update,
        rawOutput: {
          content: update.content,
        },
      },
    },
  } as AcpStreamMessage;
}

function assertAcpStreamMessage(value: AnyMessage): AcpStreamMessage {
  if (!isRecord(value) || value.jsonrpc !== "2.0") {
    throw new Error("DeepSeek Harness ACP received an invalid JSON-RPC frame");
  }
  const record = value as unknown as RecordValue;

  const hasMethod = hasOwn(record, "method");
  const hasId = hasOwn(record, "id");
  const hasResult = hasOwn(record, "result");
  const hasError = hasOwn(record, "error");

  if (hasMethod) {
    if (typeof record.method !== "string" || record.method.length === 0) {
      throw new Error("DeepSeek Harness ACP received an invalid RPC method");
    }
    if (hasId && !isRpcId(record.id)) {
      throw new Error("DeepSeek Harness ACP received an invalid RPC id");
    }
    if (hasResult || hasError) {
      throw new Error("DeepSeek Harness ACP received a mixed RPC frame");
    }
    return value as unknown as AcpStreamMessage;
  }

  if (!hasId || !isRpcId(record.id)) {
    throw new Error("DeepSeek Harness ACP received an invalid RPC response id");
  }
  if (hasResult === hasError) {
    throw new Error("DeepSeek Harness ACP received an invalid RPC response");
  }
  if (hasError && !isRpcError(record.error)) {
    throw new Error("DeepSeek Harness ACP received an invalid RPC error");
  }
  return value as unknown as AcpStreamMessage;
}

function isRequestFrame(
  value: AcpStreamMessage,
): value is AcpStreamMessage & {
  method: string;
  id: string | number | null;
} {
  const record = value as unknown as RecordValue;
  return (
    isRecord(record) &&
    hasOwn(record, "method") &&
    hasOwn(record, "id") &&
    typeof record.method === "string" &&
    isRpcId(record.id)
  );
}

function isNotificationFrame(
  value: AcpStreamMessage,
): value is AcpStreamMessage & { method: string; params?: unknown } {
  const record = value as unknown as RecordValue;
  return (
    isRecord(record) &&
    hasOwn(record, "method") &&
    !hasOwn(record, "id") &&
    typeof record.method === "string"
  );
}

function isResponseFrame(
  value: AcpStreamMessage,
): value is AcpStreamMessage & {
  id: string | number | null;
  result?: unknown;
  error?: unknown;
} {
  const record = value as unknown as RecordValue;
  return (
    isRecord(record) &&
    !hasOwn(record, "method") &&
    hasOwn(record, "id") &&
    isRpcId(record.id) &&
    hasOwn(record, "result") !== hasOwn(record, "error")
  );
}

function isLoadSessionParams(value: unknown): value is RecordValue {
  return (
    isRecord(value) &&
    typeof value.sessionId === "string" &&
    typeof value.cwd === "string" &&
    Array.isArray(value.mcpServers)
  );
}

function validateLoadCapability(capabilities: RecordValue): boolean {
  if (
    hasOwn(capabilities, "loadSession") &&
    capabilities.loadSession !== undefined &&
    typeof capabilities.loadSession !== "boolean"
  ) {
    throw new Error(
      "DeepSeek Harness ACP initialize returned invalid loadSession capability",
    );
  }
  return capabilities.loadSession === true;
}

function isRpcId(value: unknown): value is string | number | null {
  return (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function isRpcError(value: unknown): value is RecordValue {
  return (
    isRecord(value) &&
    typeof value.code === "number" &&
    Number.isFinite(value.code) &&
    typeof value.message === "string"
  );
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: RecordValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function assertConnectorOpen(
  context: DshConnectorContext,
  phase: string,
): void {
  if (context.isClosed?.()) {
    throw new Error("DeepSeek Harness connector closed " + phase);
  }
}

async function registerConnectorResource(
  context: DshConnectorContext,
  resource: ConnectorResource,
  phase: string,
): Promise<void> {
  const reason = new Error(
    "DeepSeek Harness connector closed while registering " + phase,
  );
  if (context.isClosed?.()) {
    await resource.close(reason);
    throw reason;
  }

  context.resources.add(resource);
  if (!context.isClosed?.()) {
    return;
  }

  context.resources.delete(resource);
  try {
    await resource.close(reason);
  } catch (error) {
    throw new AggregateError(
      [reason, error],
      "DeepSeek Harness connector failed to close " + phase,
    );
  }
  throw reason;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function diagnosticSuffix(value: string): string {
  const diagnostic = redactDiagnostic(value);
  return diagnostic ? " Diagnostic: " + diagnostic : "";
}

class BoundedCapture {
  private text = "";

  public constructor(private readonly limit: number) {}

  public append(chunk: unknown): void {
    if (this.text.length >= this.limit) {
      return;
    }
    const value =
      typeof chunk === "string"
        ? chunk
        : Buffer.from(chunk as Uint8Array).toString("utf8");
    this.text += value.slice(0, this.limit - this.text.length);
  }

  public get value(): string {
    return this.text;
  }
}

class ChildProcessOwner implements AcpStreamOwner {
  private readonly listeners = new Set<(error: Error) => void>();
  private failure: Error | undefined;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private exitedValue = false;

  public constructor(
    private readonly child: ChildProcess,
    private readonly command: string,
    private readonly diagnostics: () => string,
  ) {
    child.once("error", (error) => {
      this.reportFailure(
        new Error(
          "DeepSeek Harness ACP process failed for " +
            command +
            "." +
            diagnosticSuffix(this.diagnostics()),
          { cause: error },
        ),
      );
    });
    child.once("close", (code, signal) => {
      this.exitedValue = true;
      if (!this.closed) {
        this.reportFailure(
          new Error(
            "DeepSeek Harness ACP process exited (" +
              (signal ?? code ?? "unknown") +
              ")." +
              diagnosticSuffix(this.diagnostics()),
          ),
        );
      }
    });
  }

  public get hasExited(): boolean {
    return (
      this.exitedValue ||
      this.child.exitCode !== null ||
      this.child.signalCode !== null
    );
  }

  public onFailure(listener: (error: Error) => void): () => void {
    this.listeners.add(listener);
    if (this.failure) {
      queueMicrotask(() => listener(this.failure as Error));
    }
    return () => this.listeners.delete(listener);
  }

  public close(reason?: unknown): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closed = true;
    this.closePromise = terminateChild(
      this.child,
      () => this.hasExited,
      reason,
    );
    return this.closePromise;
  }

  private reportFailure(error: Error): void {
    if (this.closed || this.failure) {
      return;
    }
    this.failure = error;
    for (const listener of this.listeners) {
      listener(error);
    }
    void this.close(error).catch(() => undefined);
  }
}

/** Checks the Node and DSH versions with the daemon-resolved launch. */
export async function checkDshStatus(
  launch: ProviderLaunch,
  cwd = process.cwd(),
): Promise<ProviderStatus> {
  try {
    assertSupportedNodeVersion();
    await probeDshVersion(launch, cwd, launch.env, {
      launch,
      cwd,
      env: {},
      resources: new Set(),
    });
    return { available: true };
  } catch (error) {
    return { available: false, diagnostic: asError(error).message };
  }
}

async function probeDshVersion(
  launch: ProviderLaunch,
  cwd: string,
  env: Record<string, string>,
  context: DshConnectorContext,
): Promise<void> {
  assertConnectorOpen(context, "before version probe");
  const { command } = launch;
  let child: ChildProcess;
  try {
    child = spawnProcess(command, [...launch.args, "--version"], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw launchPathError(command, cwd, error);
  }

  const stdout = new BoundedCapture(STDERR_CAPTURE_LIMIT);
  const stderr = new BoundedCapture(STDERR_CAPTURE_LIMIT);
  child.stdout?.on("data", (chunk: unknown) => stdout.append(chunk));
  child.stderr?.on("data", (chunk: unknown) => stderr.append(chunk));
  const owner = new ChildProcessOwner(child, command, () => stderr.value);

  try {
    await registerConnectorResource(context, owner, "version probe");
    const result = await waitForProbe(child);
    assertConnectorOpen(context, "during version probe");
    if (result.error) {
      if (isMissingPathError(result.error)) {
        throw launchPathError(command, cwd, result.error);
      }
      throw new Error(
        "DeepSeek Harness version probe could not run " +
          command +
          "." +
          diagnosticSuffix(stderr.value),
        { cause: result.error },
      );
    }
    if (result.timedOut) {
      throw new Error(
        "DeepSeek Harness version probe timed out after " +
          VERSION_PROBE_TIMEOUT_MS +
          "ms for " +
          command +
          "." +
          diagnosticSuffix(stderr.value),
      );
    }
    if (result.code !== 0 || result.signal !== null) {
      throw new Error(
        "DeepSeek Harness version probe failed for " +
          command +
          " with exit " +
          (result.signal ?? result.code ?? "unknown") +
          "." +
          diagnosticSuffix(stdout.value + "\n" + stderr.value),
      );
    }

    const version = extractDshVersion(stdout.value + "\n" + stderr.value);
    if (!isSupportedDshVersion(version)) {
      throw new Error(
        "Unsupported DeepSeek Harness version " +
          (version ?? "unknown") +
          ". This plugin requires DeepSeek Harness " +
          MINIMUM_DSH_VERSION +
          " or newer; upgrade DSH or point agents.providers.deepseek-harness.command at the intended executable." +
          diagnosticSuffix(stdout.value + "\n" + stderr.value),
      );
    }
  } finally {
    await owner.close(new Error("DeepSeek Harness version probe finished")).catch(
      () => undefined,
    );
    context.resources.delete(owner);
  }
}

interface ProbeResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
  timedOut: boolean;
}

function waitForProbe(child: ChildProcess): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let spawnError: Error | undefined;

    const finish = (result: Omit<ProbeResult, "timedOut">): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      child.off("error", onError);
      child.off("close", onClose);
      resolve({ ...result, timedOut });
    };

    const onError = (error: Error): void => {
      spawnError = asError(error);
      if (child.exitCode !== null || child.signalCode !== null) {
        finish({
          code: child.exitCode,
          signal: child.signalCode,
          error: spawnError,
        });
      }
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish({
        code,
        signal,
        error: spawnError,
      });
    };
    child.once("error", onError);
    child.once("close", onClose);
    timer = setTimeout(() => {
      // The cleanup-triggered close event normally wins this race. Latch the
      // deadline first so exit 143/SIGTERM cannot conceal the timeout cause.
      timedOut = true;
      void terminateChild(child, () => child.exitCode !== null || child.signalCode !== null)
        .catch(() => undefined)
        .finally(() =>
          finish({
            code: child.exitCode,
            signal: child.signalCode,
            error: spawnError,
          }),
        );
    }, VERSION_PROBE_TIMEOUT_MS);
  });
}

function waitForChildSpawn(child: ChildProcess): Promise<void> {
  if (child.pid !== undefined && child.pid !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("DeepSeek Harness ACP process did not spawn in time"));
    }, STARTUP_TIMEOUT_MS);
    const onSpawn = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off("spawn", onSpawn);
      child.off("error", onError);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

async function terminateChild(
  child: ChildProcess,
  hasExited: () => boolean,
  reason?: unknown,
): Promise<void> {
  if (hasExited()) {
    return;
  }

  // On Windows terminateProcess force-stops the whole tree at once, including
  // DSH behind a .cmd launcher; elsewhere it sends the signal to the child.
  let firstKillError: unknown;
  try {
    await terminateProcess(child, "SIGTERM");
  } catch (error) {
    firstKillError = error;
  }
  if (await waitForChildClose(child, hasExited, SHUTDOWN_SIGNAL_TIMEOUT_MS)) {
    return;
  }

  let secondKillError: unknown;
  try {
    await terminateProcess(child, "SIGKILL");
  } catch (error) {
    secondKillError = error;
  }
  if (await waitForChildClose(child, hasExited, SHUTDOWN_SIGNAL_TIMEOUT_MS)) {
    return;
  }

  throw new Error(
    "DeepSeek Harness ACP process did not terminate after SIGTERM and SIGKILL." +
      (reason ? " Cleanup reason: " + asError(reason).message : "") +
      (firstKillError ? " SIGTERM: " + asError(firstKillError).message : "") +
      (secondKillError ? " SIGKILL: " + asError(secondKillError).message : ""),
  );
}

function waitForChildClose(
  child: ChildProcess,
  hasExited: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  if (hasExited()) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => finish(false), timeoutMs);
    const onClose = (): void => finish(true);
    const finish = (value: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.off("close", onClose);
      resolve(value || hasExited());
    };
    child.once("close", onClose);
    if (hasExited()) {
      finish(true);
    }
  });
}

function isMissingPathError(error: Error): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function launchPathError(command: string, cwd: string, cause: unknown): Error {
  return new Error(
    "DeepSeek Harness could not start executable " +
      command +
      " in working directory " + cwd +
      ". Check that both the executable and working directory exist. Install the official DeepSeek Harness package, or set agents.providers.deepseek-harness.command in the Paseo config to its path.",
    { cause },
  );
}
