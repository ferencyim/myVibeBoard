const PASEO_NODE_ENV = "PASEO_NODE_ENV";
const ELECTRON_RUN_AS_NODE = "ELECTRON_RUN_AS_NODE";

const RUNTIME_CONTROL_ENV_KEYS = [
  PASEO_NODE_ENV,
  "PASEO_DESKTOP_MANAGED",
  "PASEO_SUPERVISED",
  ELECTRON_RUN_AS_NODE,
  "ELECTRON_NO_ATTACH_CONSOLE",
  "ESBUILD_BINARY_PATH",
] as const;

export type PaseoNodeEnv = "development" | "production" | "test";
export type ProcessEnvRecord = Record<string, string | undefined>;
export type ExternalProcessEnv = NodeJS.ProcessEnv & Record<string, string>;

let cachedProcessEnv: { snapshot: ProcessEnvRecord; sanitized: ExternalProcessEnv } | undefined;

function buildInternalProcessEnv<T extends ProcessEnvRecord>(baseEnv: T): T {
  return { ...baseEnv };
}

function buildExternalProcessEnv(
  baseEnv: ProcessEnvRecord,
  overlays: ProcessEnvRecord[],
): ExternalProcessEnv {
  // process.env is mutable, so validate its complete snapshot before reusing the
  // sanitized base. Return a fresh object: callers are allowed to modify it.
  if (baseEnv === process.env) {
    const keys = Object.keys(baseEnv);
    if (
      !cachedProcessEnv ||
      keys.length !== Object.keys(cachedProcessEnv.snapshot).length ||
      keys.some((key) => cachedProcessEnv?.snapshot[key] !== baseEnv[key])
    ) {
      const snapshot = Object.assign({}, baseEnv);
      cachedProcessEnv = { snapshot, sanitized: sanitizeExternalEnv(Object.assign({}, snapshot)) };
    }
    const sanitized = Object.assign({}, cachedProcessEnv.sanitized, ...overlays);
    for (const key of RUNTIME_CONTROL_ENV_KEYS) delete sanitized[key];
    for (const overlay of overlays) {
      for (const key of Object.keys(overlay)) {
        if (sanitized[key] === undefined) delete sanitized[key];
      }
    }
    return sanitized;
  }
  const sanitized = Object.assign({}, baseEnv, ...overlays);
  return sanitizeExternalEnv(sanitized);
}

function sanitizeExternalEnv(sanitized: ProcessEnvRecord): ExternalProcessEnv {
  for (const key of RUNTIME_CONTROL_ENV_KEYS) {
    delete sanitized[key];
  }
  for (const [key, value] of Object.entries(sanitized)) {
    if (value === undefined) {
      delete sanitized[key];
    }
  }
  return sanitized as ExternalProcessEnv;
}

export function createPaseoInternalEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return buildInternalProcessEnv(baseEnv);
}

export function createExternalProcessEnv(
  baseEnv: ProcessEnvRecord,
  ...overlays: ProcessEnvRecord[]
): ExternalProcessEnv {
  return buildExternalProcessEnv(baseEnv, overlays);
}

export function createExternalCommandProcessEnv(
  _command: string,
  baseEnv: ProcessEnvRecord,
  ...overlays: ProcessEnvRecord[]
): ExternalProcessEnv {
  // Deprecated command parameter: retained while callers migrate to createExternalProcessEnv.
  return buildExternalProcessEnv(baseEnv, overlays);
}

export function buildSelfNodeCommand(
  args: string[],
  envOverlay?: ProcessEnvRecord,
): {
  command: string;
  args: string[];
  env: ExternalProcessEnv;
} {
  const env = buildExternalProcessEnv(process.env, []);
  Object.assign(env, { [ELECTRON_RUN_AS_NODE]: "1" }, envOverlay);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete env[key];
    }
  }
  return {
    command: process.execPath,
    args,
    env,
  };
}

export function resolvePaseoNodeEnv(env: NodeJS.ProcessEnv): PaseoNodeEnv | undefined {
  const value = env[PASEO_NODE_ENV];
  return value === "development" || value === "production" || value === "test" ? value : undefined;
}
