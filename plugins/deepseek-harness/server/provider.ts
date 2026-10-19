import { AsyncLocalStorage } from "node:async_hooks";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import type {
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
  ProviderLaunch,
  ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import {
  checkDshStatus,
  createDshAcpStream,
  type ConnectorResource,
  type DshConnectorContext,
} from "./dsh-compatibility";

const PROVIDER_ID = "deepseek-harness";
const DEFAULT_COMMAND = ["dsh", "--profile", "acp"] as const;
const MISSING_LAUNCH =
  "DeepSeek Harness requires Paseo 0.11 or newer, which supplies the resolved dsh launch";
const CLOSE_TIMEOUT_MS = 5_000;
const COMMAND_CAPABILITY = "prompt.command";

export interface DeepSeekHarnessProviderOptions {
  startupTimeoutMs?: number;
}

export interface ManagedDeepSeekHarnessProvider extends ProviderRegistration {
  dispose(): Promise<void>;
}

interface InputContext {
  cwd: string;
  env: Readonly<Record<string, string>>;
}

interface ConnectionScope extends InputContext {
  launch: ProviderLaunch;
  resources: Set<ConnectorResource>;
  closed: boolean;
  closeConnection?: () => Promise<void>;
  closePromise?: Promise<void>;
  resourceClosePromise?: Promise<void>;
}

export function createDeepSeekHarnessProvider(
  options: DeepSeekHarnessProviderOptions = {},
): ManagedDeepSeekHarnessProvider {
  validateOptions(options);

  const storage = new AsyncLocalStorage<ConnectionScope>();
  const scopes = new Set<ConnectionScope>();
  const pendingConnects = new Set<Promise<ProviderConnection>>();
  let disposed = false;
  let disposePromise: Promise<void> | undefined;
  const delegate = runAcpProvider({
    id: PROVIDER_ID,
    label: "DeepSeek Harness",
    description: "DeepSeek Harness through its official ACP profile.",
    icon: "icon.svg",
    ...(options.startupTimeoutMs === undefined
      ? {}
      : { acpOptions: { startupTimeoutMs: options.startupTimeoutMs } }),
    connector: () => {
      const scope = storage.getStore();
      if (!scope) {
        throw new Error(
          "DeepSeek Harness connector was requested without an input context",
        );
      }
      const context: DshConnectorContext = {
        launch: scope.launch,
        cwd: scope.cwd,
        env: scope.env,
        resources: scope.resources,
        isClosed: () => scope.closed,
      };
      return createDshAcpStream(context);
    },
  });

  const closeScopeResources = (scope: ConnectionScope): Promise<void> => {
    if (!scope.resourceClosePromise) {
      scope.resourceClosePromise = closeResources(scope.resources);
    }
    return scope.resourceClosePromise;
  };

  const closeScope = (
    scope: ConnectionScope,
    connection: ProviderConnection,
  ): Promise<void> => {
    if (scope.closePromise) {
      return scope.closePromise;
    }
    scope.closed = true;

    let delegateClose: Promise<void>;
    try {
      delegateClose = connection.close();
    } catch (error) {
      delegateClose = Promise.reject(error);
    }
    void delegateClose.catch(() => undefined);

    const resourceClose = closeScopeResources(scope);
    scope.closePromise = (async () => {
      const results = await Promise.allSettled([
        resourceClose,
        withTimeout(
          delegateClose,
          CLOSE_TIMEOUT_MS,
          "DeepSeek Harness provider close timed out",
        ),
      ]);
      const errors = results
        .filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        )
        .map((result) => result.reason);
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(
          errors,
          "DeepSeek Harness provider cleanup failed",
        );
      }
    })();
    void scope.closePromise.then(
      () => scopes.delete(scope),
      () => scopes.delete(scope),
    );
    return scope.closePromise;
  };

  const connectScope = async (
    scope: ConnectionScope,
    request: Parameters<ProviderRegistration["connect"]>[0],
  ): Promise<ProviderConnection> => {
    let connection: ProviderConnection;
    try {
      connection = await storage.run(scope, () => delegate.connect(request));
    } catch (error) {
      let resourceError: unknown;
      try {
        await closeScopeResources(scope);
      } catch (cleanupError) {
        resourceError = cleanupError;
      }
      scopes.delete(scope);
      if (resourceError !== undefined) {
        throw new AggregateError(
          [error, resourceError],
          "DeepSeek Harness provider connect cleanup failed",
        );
      }
      throw error;
    }

    scope.closeConnection = () => closeScope(scope, connection);
    if (disposed || scope.closed) {
      scope.closed = true;
      try {
        await scope.closeConnection();
      } catch (error) {
        throw new AggregateError(
          [
            new Error(
              "DeepSeek Harness provider was closed while connecting",
            ),
            error,
          ],
          "DeepSeek Harness provider connect cleanup failed",
        );
      }
      throw new Error("DeepSeek Harness provider was closed while connecting");
    }

    const capabilities = withoutUnsupportedCapabilities(
      connection.capabilities,
    );
    return {
      version: connection.version,
      capabilities,
      async send(input) {
        if (scope.closed) {
          throw new Error("DeepSeek Harness provider connection is closed");
        }
        if (isCommandPrompt(input)) {
          throw new Error(
            "DeepSeek Harness ACP does not support provider commands",
          );
        }
        const inputContext = contextForInput(input);
        const inputScope: ConnectionScope = {
          ...inputContext,
          launch: scope.launch,
          resources: scope.resources,
          get closed() {
            return scope.closed;
          },
        };
        return storage.run(inputScope, () => connection.send(input));
      },
      onEvent(listener) {
        return connection.onEvent((event) =>
          listener(filterProviderEvent(event)),
        );
      },
      close: () => closeScope(scope, connection),
    };
  };

  const registration: ManagedDeepSeekHarnessProvider = {
    ...delegate,
    command: DEFAULT_COMMAND,
    async status(request) {
      if (!request.launch) {
        return { available: false, diagnostic: MISSING_LAUNCH };
      }
      return checkDshStatus(request.launch);
    },
    async connect(request) {
      if (disposed) {
        throw new Error("DeepSeek Harness provider has been disposed");
      }
      if (!request.launch) {
        throw new Error(MISSING_LAUNCH);
      }

      const resources = new Set<ConnectorResource>();
      const scope: ConnectionScope = {
        launch: request.launch,
        cwd: process.cwd(),
        env: {},
        resources,
        closed: false,
      };
      scopes.add(scope);
      const pending = connectScope(scope, request);
      pendingConnects.add(pending);
      try {
        return await pending;
      } finally {
        pendingConnects.delete(pending);
      }
    },
    dispose() {
      if (disposePromise) {
        return disposePromise;
      }
      disposed = true;
      const scopesAtDispose = [...scopes];
      const pendingAtDispose = [...pendingConnects];
      for (const scope of scopesAtDispose) {
        scope.closed = true;
      }
      disposePromise = (async () => {
        const errors: unknown[] = [];
        const tracked = new Set<Promise<unknown>>();

        const waitForCleanup = async (
          operations: readonly Promise<unknown>[],
        ): Promise<void> => {
          const fresh = operations.filter((operation) => {
            if (tracked.has(operation)) {
              return false;
            }
            tracked.add(operation);
            return true;
          });
          const results = await Promise.allSettled(fresh);
          for (const result of results) {
            if (result.status === "rejected") {
              errors.push(result.reason);
            }
          }
        };

        await waitForCleanup(
          scopesAtDispose.map((scope) =>
            scope.closeConnection
              ? scope.closeConnection()
              : closeScopeResources(scope),
          ),
        );
        await Promise.allSettled(pendingAtDispose);

        while (true) {
          const lateClosing = [...scopes]
            .map((scope) => scope.closePromise ?? scope.resourceClosePromise)
            .filter((operation): operation is Promise<void> =>
              operation !== undefined,
            );
          const freshClosing = lateClosing.filter(
            (operation) => !tracked.has(operation),
          );
          if (freshClosing.length === 0) {
            break;
          }
          await waitForCleanup(freshClosing);
        }

        scopes.clear();
        for (const pending of pendingAtDispose) {
          pendingConnects.delete(pending);
        }
        if (errors.length === 1) {
          throw errors[0];
        }
        if (errors.length > 1) {
          throw new AggregateError(
            errors,
            "DeepSeek Harness provider dispose failed",
          );
        }
      })();
      return disposePromise;
    },
  };
  return registration;
}

export const createProvider = createDeepSeekHarnessProvider;

function contextForInput(input: ProviderInput): InputContext {
  if (input.type === "session.open") {
    return {
      cwd: input.config.cwd,
      env: { ...input.config.env },
    };
  }
  if (input.type === "catalog" || input.type === "sessions") {
    return {
      cwd: input.cwd ?? process.cwd(),
      env: {},
    };
  }
  return {
    cwd: process.cwd(),
    env: {},
  };
}

function isCommandPrompt(input: ProviderInput): boolean {
  return (
    input.type === "session.prompt" && input.prompt.input.type === "command"
  );
}

function withoutUnsupportedCapabilities(
  capabilities: readonly string[],
): readonly string[] {
  return capabilities.filter(
    (capability) => capability !== COMMAND_CAPABILITY,
  );
}

function filterProviderEvent(event: ProviderEvent): ProviderEvent {
  if (event.type !== "session.opened") {
    return event;
  }
  return {
    ...event,
    capabilities: withoutUnsupportedCapabilities(event.capabilities),
  };
}

async function closeResources(
  resources: Set<ConnectorResource>,
): Promise<void> {
  const results = await Promise.allSettled(
    [...resources].map(async (resource) => {
      await resource.close(
        new Error("Paseo closed the DeepSeek Harness provider"),
      );
    }),
  );
  const errors = results
    .filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    )
    .map((result) => result.reason);
  resources.clear();
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      "DeepSeek Harness child process cleanup failed",
    );
  }
}

async function withTimeout(
  promise: Promise<void>,
  timeoutMs: number,
  message: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function validateOptions(options: DeepSeekHarnessProviderOptions): void {
  if (
    options.startupTimeoutMs !== undefined &&
    (!Number.isFinite(options.startupTimeoutMs) ||
      options.startupTimeoutMs <= 0)
  ) {
    throw new Error("DeepSeek Harness startupTimeoutMs must be positive");
  }
}
