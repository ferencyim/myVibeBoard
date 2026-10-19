import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  ProviderEventSchema,
  type ProviderConnectRequest,
  type ProviderContent,
  type ProviderEvent,
  type ProviderInput,
  type ProviderLaunch,
} from "@getpaseo/plugin/server/provider";
import serverEntry from "../index.server";
import {
  createDeepSeekHarnessProvider,
  type ManagedDeepSeekHarnessProvider,
  type DeepSeekHarnessProviderOptions,
} from "./provider";
import {
  createDshAcpStream,
  type ConnectorResource,
} from "./dsh-compatibility";

const fakeDsh = fileURLToPath(
  new URL("../tests/fixtures/fake-dsh.mjs", import.meta.url),
);
const modelFlash = '["deepseek-official","deepseek-v4-flash"]';
const modelPro = '["deepseek-official","deepseek-v4-pro"]';
const environmentKeys = [
  "DSH_FAKE_VERSION",
  "DSH_FAKE_CAPABILITIES",
  "DSH_FAKE_NO_INITIALIZE",
  "DSH_FAKE_HANG_VERSION",
  "DSH_FAKE_SPAWN_LOG",
  "DSH_FAKE_SIGTERM_DELAY_MS",
];

let testRoot = "";
let cwdA = "";
let cwdB = "";
const originalEnvironment = new Map<string, string | undefined>();

beforeAll(async () => {
  for (const key of environmentKeys) {
    originalEnvironment.set(key, process.env[key]);
  }
  testRoot = await mkdtemp(join(tmpdir(), "paseo-deepseek-harness-"));
  cwdA = join(testRoot, "a");
  cwdB = join(testRoot, "b");
  await import("node:fs/promises").then(({ mkdir }) =>
    Promise.all([mkdir(cwdA), mkdir(cwdB)]),
  );
  delete process.env.DSH_FAKE_VERSION;
  delete process.env.DSH_FAKE_CAPABILITIES;
  delete process.env.DSH_FAKE_NO_INITIALIZE;
  delete process.env.DSH_FAKE_HANG_VERSION;
  delete process.env.DSH_FAKE_SIGTERM_DELAY_MS;
});

afterAll(async () => {
  for (const key of environmentKeys) {
    const value = originalEnvironment.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  await rm(testRoot, { recursive: true, force: true });
});

describe.sequential("DeepSeek Harness provider", () => {
  it.each([0, -1, NaN, Infinity])("rejects invalid startup timeout %s before connecting", (startupTimeoutMs) => {
    expect(() => createDeepSeekHarnessProvider({ startupTimeoutMs })).toThrow("must be positive");
  });

  it("rejects command prompts even if a caller ignores advertised capabilities", async () => {
    const provider = createDeepSeekHarnessProvider();
    const connection = await provider.connect(connectRequest());
    try {
      await expect(connection.send({
        type: "session.prompt", sessionId: "not-opened",
        prompt: {
          clientMessageId: "command-test", delivery: "auto",
          input: { type: "command", name: "unsupported", arguments: "" },
        },
      })).rejects.toThrow("does not support provider commands");
    } finally {
      await provider.dispose();
    }
  });

  it("registers the true server provider entry and exposes the managed factory", async () => {
    const registerProvider = vi.fn();
    const registerUsageSource = vi.fn();
    const cleanup = serverEntry({
      registerProvider,
      registerUsageSource,
    } as unknown as PluginServerContext);
    expect(registerProvider).toHaveBeenCalledOnce();
    expect(registerUsageSource).toHaveBeenCalledOnce();
    expect(registerUsageSource.mock.calls[0]?.[0]).toMatchObject({
      id: "deepseek",
      icon: "icon.svg",
    });
    const provider = registerProvider.mock.calls[0]?.[0];
    expect(provider).toMatchObject({
      id: "deepseek-harness",
      label: "DeepSeek Harness",
      icon: "icon.svg",
    });
    expect(typeof provider?.connect).toBe("function");
    expect(typeof provider?.dispose).toBe("function");
    expect(typeof cleanup).toBe("function");
    await cleanup();
  });

  it("ships the registered provider icon in the npm package", async () => {
    const registerProvider = vi.fn();
    const cleanup = serverEntry({
      registerProvider,
      registerUsageSource: vi.fn(),
    } as unknown as PluginServerContext);
    const icon: unknown = registerProvider.mock.calls[0]?.[0]?.icon;
    await cleanup();

    const root = fileURLToPath(new URL("..", import.meta.url));
    const pkg = JSON.parse(
      await readFile(join(root, "package.json"), "utf8"),
    ) as { files: string[] };
    expect(typeof icon).toBe("string");
    expect(pkg.files).toContain(icon);
    expect((await readFile(join(root, icon as string))).length).toBeGreaterThan(0);
  });

  it("discovers catalog values, runs turns, preserves tool tails, and resumes without replay", async () => {
    const connection = await connect();
    const collector = collect(connection);
    try {
      expect(connection.capabilities).toContain("prompt.message");
      expect(connection.capabilities).toContain("prompt.image");
      expect(connection.capabilities).toContain("session.list");
      expect(connection.capabilities).toContain("session.persistence");
      expect(connection.capabilities).not.toContain("prompt.command");
      expect(connection.capabilities).not.toContain("prompt.steer");

      await connection.send({
        type: "catalog",
        requestId: "catalog-1",
        cwd: testRoot,
      });
      const catalog = await collector.waitFor(
        (event) => event.type === "catalog" && event.requestId === "catalog-1",
      );
      if (catalog.type !== "catalog") {
        throw new Error("catalog event was not returned");
      }
      expect(catalog.catalog.defaultModel).toBe(modelFlash);
      expect(catalog.catalog.models.map((model) => model.id)).toContain(
        modelFlash,
      );
      expect(catalog.catalog.models.map((model) => model.id)).toContain(
        modelPro,
      );
      expect(
        catalog.catalog.thinkingOptions?.map((option) => option.id),
      ).toEqual(["off", "low", "high", "max"]);

      const open = openInput("main", cwdA, "A", "skip");
      await connection.send(open);
      const opened = await collector.waitFor(
        (event) =>
          event.type === "session.opened" && event.sessionId === open.sessionId,
      );
      const ready = await waitForReady(collector, open.sessionId);
      expect(ready.type).toBe("session.ready");
      if (opened.type !== "session.opened") {
        throw new Error("session did not open");
      }
      expect(opened.restoration).toBe("core");
      expect(opened.cwd).toBe(cwdA);
      expect(opened.capabilities).not.toContain("prompt.command");
      expect(opened.persistence?.data).toMatchObject({
        sessionId: expect.stringMatching(/^fresh-/),
      });
      const persistence = opened.persistence;
      expect(persistence).toBeDefined();

      await connection.send(messagePrompt(open.sessionId, "m1", "remember"));
      await collector.waitFor(
        (event) =>
          event.type === "session.turn" &&
          event.sessionId === open.sessionId &&
          event.turnId === "acp:m1" &&
          event.state === "completed",
      );
      const firstAssistant = await collector.waitFor(
        (event) =>
          event.type === "timeline.item" &&
          event.sessionId === open.sessionId &&
          event.item.type === "assistant_message" &&
          event.item.text.includes("marker=A"),
      );
      expect(firstAssistant.type).toBe("timeline.item");
      expect(
        collector.events.filter(
          (event) =>
            event.type === "session.prompt_result" &&
            event.clientMessageId === "m1",
        ),
      ).toHaveLength(1);

      const toolStart = collector.events.length;
      await connection.send(messagePrompt(open.sessionId, "m2", "tool"));
      const tool = await collector.waitFor(
        (event) =>
          event.type === "timeline.item" &&
          event.sessionId === open.sessionId &&
          event.item.type === "tool_call" &&
          event.item.id === "long-tool" &&
          event.item.status === "completed",
        5_000,
        toolStart,
      );
      if (tool.type !== "timeline.item" || tool.item.type !== "tool_call") {
        throw new Error("tool event was not returned");
      }
      expect(tool.item.detail.type).toBe("unknown");
      if (tool.item.detail.type === "unknown") {
        const output = tool.item.detail.output as {
          content?: Array<{ content?: { text?: string } }>;
        };
        const outputText = output.content?.[0]?.content?.text ?? "";
        expect(outputText.length).toBeGreaterThan(24_000);
        expect(outputText).toContain("tool-output-start");
        expect(outputText.endsWith("tool-output-tail")).toBe(true);
      }
      await collector.waitFor(
        (event) =>
          event.type === "session.turn" &&
          event.sessionId === open.sessionId &&
          event.turnId === "acp:m2" &&
          event.state === "completed",
        5_000,
        toolStart,
      );
      expect(
        collector.events.slice(toolStart).some(
          (event) =>
            event.type === "session.usage" &&
            event.sessionId === open.sessionId &&
            event.usage.contextWindowUsedTokens === 123,
        ),
      ).toBe(true);

      const imageStart = collector.events.length;
      await connection.send(
        messagePrompt(open.sessionId, "m3", "image", [
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ]),
      );
      const imageAssistant = await collector.waitFor(
        (event) =>
          event.type === "timeline.item" &&
          event.sessionId === open.sessionId &&
          event.item.type === "assistant_message" &&
          event.item.text.includes("image=yes"),
        5_000,
        imageStart,
      );
      expect(imageAssistant.type).toBe("timeline.item");
      expect(
        collector.events.slice(imageStart).some(
          (event) =>
            event.type === "timeline.item" &&
            event.item.type === "assistant_message" &&
            event.item.text.includes("mcp=yes"),
        ),
      ).toBe(true);

      await connection.send({
        type: "session.configure",
        requestId: "configure-1",
        sessionId: open.sessionId,
        changes: { model: modelPro, thinkingOption: "high" },
      });
      await collector.waitFor(
        (event) =>
          event.type === "request.completed" &&
          event.requestId === "configure-1",
      );
      const configured = await collector.waitFor(
        (event) =>
          event.type === "session.config" &&
          event.sessionId === open.sessionId &&
          event.config.model === modelPro &&
          event.config.thinkingOption === "high",
      );
      expect(configured.type).toBe("session.config");

      await connection.send({
        type: "sessions",
        requestId: "sessions-1",
        cwd: cwdA,
        limit: 1,
      });
      const sessions = await collector.waitFor(
        (event) => event.type === "sessions" && event.requestId === "sessions-1",
      );
      if (sessions.type !== "sessions") {
        throw new Error("sessions event was not returned");
      }
      expect(sessions.sessions).toHaveLength(1);
      expect(sessions.sessions[0]?.cwd).toBe(cwdA);

      await connection.send({
        type: "session.close",
        requestId: "close-main",
        sessionId: open.sessionId,
      });
      await collector.waitFor(
        (event) =>
          event.type === "session.closed" && event.sessionId === open.sessionId,
      );

      const resumeStart = collector.events.length;
      const resumedOpen = openInput(
        open.sessionId,
        cwdA,
        "A",
        "replay",
        persistence,
      );
      await connection.send(resumedOpen);
      const resumed = await collector.waitFor(
        (event) =>
          event.type === "session.opened" &&
          event.sessionId === resumedOpen.sessionId,
        3_000,
        resumeStart,
      );
      await waitForReady(collector, resumedOpen.sessionId, 0, resumeStart);
      if (resumed.type !== "session.opened") {
        throw new Error("session did not resume");
      }
      expect(resumed.persistence?.data).toEqual(persistence?.data);
      const lifecycle = await collector.waitFor(
        (event) =>
          event.type === "session.config" &&
          event.sessionId === resumedOpen.sessionId &&
          settingValue(event, "_fake_lifecycle") === "resumed",
      );
      expect(lifecycle.type).toBe("session.config");
      expect(
        collector.events.slice(resumeStart).some(
          (event) =>
            event.type === "timeline.item" &&
            event.item.type === "assistant_message" &&
            event.item.text.includes("marker=A"),
        ),
      ).toBe(false);

      await connection.send({
        type: "session.close",
        requestId: "close-resumed",
        sessionId: resumedOpen.sessionId,
      });
      await collector.waitFor(
        (event) =>
          event.type === "session.closed" &&
          event.sessionId === resumedOpen.sessionId,
      );
    } finally {
      collector.unsubscribe();
      await connection.close();
    }
  });

  it("keeps concurrent session environment and cwd contexts isolated", async () => {
    const connection = await connect();
    const collector = collect(connection);
    try {
      const a = openInput("env-a", cwdA, "A", "skip");
      const b = openInput("env-b", cwdB, "B", "skip");
      await Promise.all([connection.send(a), connection.send(b)]);
      await Promise.all([
        waitForReady(collector, a.sessionId),
        waitForReady(collector, b.sessionId),
      ]);
      const configA = await collector.waitFor(
        (event) =>
          event.type === "session.config" &&
          event.sessionId === a.sessionId &&
          settingValue(event, "_fake_marker") === "A",
      );
      const configB = await collector.waitFor(
        (event) =>
          event.type === "session.config" &&
          event.sessionId === b.sessionId &&
          settingValue(event, "_fake_marker") === "B",
      );
      expect(configA.type).toBe("session.config");
      expect(configB.type).toBe("session.config");
      expect(
        collector.events.find(
          (event) =>
            event.type === "session.opened" && event.sessionId === a.sessionId,
        ),
      ).toMatchObject({ cwd: cwdA });
      expect(
        collector.events.find(
          (event) =>
            event.type === "session.opened" && event.sessionId === b.sessionId,
        ),
      ).toMatchObject({ cwd: cwdB });

      await Promise.all([
        closeSession(connection, collector, a.sessionId, "close-a"),
        closeSession(connection, collector, b.sessionId, "close-b"),
      ]);
    } finally {
      collector.unsubscribe();
      await connection.close();
    }
  });

  it("maps permissions and errors, and cancels a pending prompt", async () => {
    const connection = await connect();
    const collector = collect(connection);
    const permissionResponses: Promise<void>[] = [];
    const permissionListener = connection.onEvent((event) => {
      ProviderEventSchema.parse(event);
      if (event.type !== "session.permission") {
        return;
      }
      permissionResponses.push(
        connection
          .send({
            type: "session.permission",
            sessionId: event.sessionId,
            permissionId: event.request.id,
            response: {
              behavior: "allow",
              selectedActionId: "allow-once",
            },
          })
          .catch(() => undefined),
      );
    });
    try {
      const open = openInput("permission", cwdA, "permission", "skip");
      await connection.send(open);
      await waitForReady(collector, open.sessionId);

      await connection.send(
        messagePrompt(open.sessionId, "permission-1", "permission"),
      );
      await collector.waitFor(
        (event) =>
          event.type === "session.permission" &&
          event.sessionId === open.sessionId,
      );
      await Promise.all(permissionResponses);
      await collector.waitFor(
        (event) =>
          event.type === "session.permission_resolved" &&
          event.sessionId === open.sessionId,
      );
      await collector.waitFor(
        (event) =>
          event.type === "session.turn" &&
          event.sessionId === open.sessionId &&
          event.turnId === "acp:permission-1" &&
          event.state === "completed",
      );

      await connection.send(
        messagePrompt(open.sessionId, "error-1", "error"),
      );
      const failed = await collector.waitFor(
        (event) =>
          event.type === "session.turn" &&
          event.sessionId === open.sessionId &&
          event.turnId === "acp:error-1" &&
          event.state === "failed",
      );
      if (failed.type !== "session.turn") {
        throw new Error("error turn was not returned");
      }
      expect(failed.error?.message).toContain("fake prompt failure");

      await connection.send(
        messagePrompt(open.sessionId, "cancel-1", "hang"),
      );
      await collector.waitFor(
        (event) =>
          event.type === "session.prompt_result" &&
          event.sessionId === open.sessionId &&
          event.clientMessageId === "cancel-1",
      );
      await connection.send({
        type: "session.interrupt",
        requestId: "interrupt-1",
        sessionId: open.sessionId,
      });
      await collector.waitFor(
        (event) =>
          event.type === "request.completed" &&
          event.requestId === "interrupt-1",
      );
      await collector.waitFor(
        (event) =>
          event.type === "session.turn" &&
          event.sessionId === open.sessionId &&
          event.turnId === "acp:cancel-1" &&
          event.state === "canceled",
      );
      await closeSession(connection, collector, open.sessionId, "close-permission");
    } finally {
      permissionListener();
      collector.unsubscribe();
      await connection.close();
    }
  });

  it("cleans up on EOF and on close during an active prompt", async () => {
    const eofConnection = await connect();
    const eofCollector = collect(eofConnection);
    try {
      const open = openInput("eof", cwdA, "eof", "skip");
      await eofConnection.send(open);
      await waitForReady(eofCollector, open.sessionId);
      await eofConnection.send(messagePrompt(open.sessionId, "eof-1", "eof"));
      const failed = await eofCollector.waitFor(
        (event) =>
          event.type === "session.runtime_failed" &&
          event.sessionId === open.sessionId,
        5_000,
      );
      expect(failed.type).toBe("session.runtime_failed");
    } finally {
      eofCollector.unsubscribe();
      await eofConnection.close();
    }

    const activeConnection = await connect();
    const activeCollector = collect(activeConnection);
    try {
      const open = openInput("active-close", cwdB, "active", "skip");
      await activeConnection.send(open);
      await waitForReady(activeCollector, open.sessionId);
      await activeConnection.send(
        messagePrompt(open.sessionId, "hang-1", "hang"),
      );
      await activeCollector.waitFor(
        (event) =>
          event.type === "session.prompt_result" &&
          event.sessionId === open.sessionId &&
          event.clientMessageId === "hang-1",
      );
      const started = Date.now();
      await activeConnection.close();
      expect(Date.now() - started).toBeLessThan(4_000);
    } finally {
      activeCollector.unsubscribe();
      await activeConnection.close();
    }
  });

  it("closes a public catalog version probe before it can spawn an ACP child", async () => {
    const logPath = join(testRoot, "close-version-probe.log");
    await writeFile(logPath, "");

    await withEnvironment({ DSH_FAKE_SPAWN_LOG: logPath }, async () => {
      const launch = testLaunch();
      const connection = await createDeepSeekHarnessProvider().connect({
        ...connectRequest(),
        launch,
      });
      try {
        await waitForFakeSpawnLog(
          logPath,
          (records) =>
            records.filter((record) => record.event === "start").length >= 2,
        );

        // Later connector calls on this connection reuse its launch environment.
        launch.env.DSH_FAKE_HANG_VERSION = "1";
        const catalog = connection.send({
          type: "catalog",
          requestId: "close-catalog",
          cwd: testRoot,
        });
        await waitForFakeSpawnLog(
          logPath,
          (records) =>
            records.filter(
              (record) =>
                record.event === "start" && record.args.includes("--version"),
            ).length >= 2,
        );

        const started = Date.now();
        await connection.close();
        await catalog;
        expect(Date.now() - started).toBeLessThan(4_000);

        const records = await waitForFakeSpawnLog(
          logPath,
          allStartedExited,
        );
        expect(
          records.filter(
            (record) => record.event === "start" && !record.args.includes("--version"),
          ),
        ).toHaveLength(1);
        expect(
          records.filter(
            (record) => record.event === "start" && record.args.includes("--version"),
          ),
        ).toHaveLength(2);
      } finally {
        await connection.close();
      }
    });
  });

  it("closes a public provider while initialize is pending and reaps its ACP child", async () => {
    const logPath = join(testRoot, "close-initialize.log");
    await writeFile(logPath, "");

    await withEnvironment({ DSH_FAKE_SPAWN_LOG: logPath }, async () => {
      const connection = await connect();
      try {
        await waitForFakeSpawnLog(
          logPath,
          (records) =>
            records.filter((record) => record.event === "start").length >= 2,
        );

        await withEnvironment({ DSH_FAKE_NO_INITIALIZE: "1" }, async () => {
          const open = connection.send(
            openInput("close-initialize", cwdA, "close-initialize", "skip"),
          );
          await waitForFakeSpawnLog(
            logPath,
            (records) =>
              records.filter(
                (record) =>
                  record.event === "start" && !record.args.includes("--version"),
              ).length >= 2,
          );

          const started = Date.now();
          await connection.close();
          await open;
          expect(Date.now() - started).toBeLessThan(4_000);
        });

        const records = await waitForFakeSpawnLog(
          logPath,
          allStartedExited,
        );
        expect(
          records.filter(
            (record) => record.event === "start" && !record.args.includes("--version"),
          ),
        ).toHaveLength(2);
      } finally {
        await connection.close();
      }
    });
  });

  it("closes a public provider while a prompt is pending and reaps its ACP child", async () => {
    const logPath = join(testRoot, "close-prompt.log");
    await writeFile(logPath, "");

    await withEnvironment({ DSH_FAKE_SPAWN_LOG: logPath }, async () => {
      const connection = await connect();
      const collector = collect(connection);
      try {
        await waitForFakeSpawnLog(
          logPath,
          (records) =>
            records.filter((record) => record.event === "start").length >= 2,
        );
        const open = openInput("close-prompt", cwdB, "close-prompt", "skip");
        await connection.send(open);
        await waitForReady(collector, open.sessionId);
        await connection.send(
          messagePrompt(open.sessionId, "close-prompt-1", "hang"),
        );
        await waitForFakeSpawnLog(
          logPath,
          (records) =>
            records.some(
              (record) => record.event === "prompt" && record.text === "hang",
            ),
        );

        const started = Date.now();
        await connection.close();
        expect(Date.now() - started).toBeLessThan(4_000);

        const records = await waitForFakeSpawnLog(
          logPath,
          allStartedExited,
        );
        expect(
          records.filter(
            (record) => record.event === "start" && !record.args.includes("--version"),
          ),
        ).toHaveLength(2);
      } finally {
        collector.unsubscribe();
        await connection.close();
      }
    });
  });

  it("disposes a provider while its initial version probe connect is pending", async () => {
    const logPath = join(testRoot, "dispose-pending-version.log");
    await writeFile(logPath, "");

    await withEnvironment(
      { DSH_FAKE_SPAWN_LOG: logPath, DSH_FAKE_HANG_VERSION: "1" },
      async () => {
        const provider = createDeepSeekHarnessProvider();
        const connecting = provider.connect(connectRequest());
        await waitForFakeSpawnLog(
          logPath,
          (records) =>
            records.some(
              (record) => record.event === "start" && record.args.includes("--version"),
            ),
        );

        const disposing = provider.dispose();
        await expect(connecting).rejects.toThrow();
        await expect(disposing).resolves.toBeUndefined();
        await expect(provider.dispose()).resolves.toBeUndefined();

        const records = await waitForFakeSpawnLog(
          logPath,
          allStartedExited,
        );
        expect(
          records.filter(
            (record) => record.event === "start" && !record.args.includes("--version"),
          ),
        ).toHaveLength(0);
      },
    );
  });

  it("disposes a provider while its initial initialize connect is pending", async () => {
    const logPath = join(testRoot, "dispose-pending-initialize.log");
    await writeFile(logPath, "");

    await withEnvironment(
      { DSH_FAKE_SPAWN_LOG: logPath, DSH_FAKE_NO_INITIALIZE: "1" },
      async () => {
        const provider = createDeepSeekHarnessProvider();
        const connecting = provider.connect(connectRequest());
        await waitForFakeSpawnLog(
          logPath,
          (records) =>
            records.some(
              (record) => record.event === "start" && !record.args.includes("--version"),
            ),
        );

        const disposing = provider.dispose();
        await expect(connecting).rejects.toThrow();
        await expect(disposing).resolves.toBeUndefined();

        const records = await waitForFakeSpawnLog(
          logPath,
          allStartedExited,
        );
        expect(
          records.filter(
            (record) => record.event === "start" && !record.args.includes("--version"),
          ),
        ).toHaveLength(1);
      },
    );
  });

  it("entry cleanup waits for a host-initiated close to settle", async () => {
    const logPath = join(testRoot, "entry-cleanup-close.log");
    await writeFile(logPath, "");

    await withEnvironment(
      {
        DSH_FAKE_SPAWN_LOG: logPath,
        DSH_FAKE_SIGTERM_DELAY_MS: "250",
      },
      async () => {
        const registerProvider = vi.fn();
        const cleanup = serverEntry({
          registerProvider,
          registerUsageSource: vi.fn(),
        } as unknown as PluginServerContext);
        const provider = registerProvider.mock.calls[0]?.[0] as
          | ManagedDeepSeekHarnessProvider
          | undefined;
        expect(provider).toBeDefined();
        if (!provider) {
          throw new Error("server entry did not register a provider");
        }

        const connection = await provider.connect(connectRequest());
        const collector = collect(connection);
        try {
          const open = openInput("entry-cleanup", cwdA, "entry-cleanup", "skip");
          await connection.send(open);
          await waitForReady(collector, open.sessionId);

          let hostCloseSettled = false;
          const hostClose = connection.close().then(() => {
            hostCloseSettled = true;
          });
          await new Promise((resolve) => setTimeout(resolve, 25));
          expect(hostCloseSettled).toBe(false);

          await cleanup();
          expect(hostCloseSettled).toBe(true);
          await hostClose;
          await cleanup();
        } finally {
          collector.unsubscribe();
          await connection.close();
          await cleanup();
        }
      },
    );
  });

  it("rejects unsupported versions and cleans up a no-response initialize", async () => {
    await withEnvironment({ DSH_FAKE_VERSION: "0.1.5-alpha.2" }, async () => {
      const provider = createDeepSeekHarnessProvider({ startupTimeoutMs: 500 });
      await expect(provider.connect(connectRequest())).rejects.toThrow(
        "Unsupported DeepSeek Harness version 0.1.5-alpha.2. This plugin requires DeepSeek Harness 0.1.5-rc.1 or newer",
      );
    });

    const missing = createDeepSeekHarnessProvider({ startupTimeoutMs: 500 });
    await expect(
      missing.connect({ ...connectRequest(), launch: testLaunch("/missing/dsh") }),
    ).rejects.toThrow("Check that both the executable and working directory exist");

    await withEnvironment({ DSH_FAKE_NO_INITIALIZE: "1" }, async () => {
      const provider = createDeepSeekHarnessProvider({ startupTimeoutMs: 150 });
      const started = Date.now();
      await expect(provider.connect(connectRequest())).rejects.toThrow(
        /did not initialize|timed out|ACP transport/,
      );
      expect(Date.now() - started).toBeLessThan(3_000);
    });
  });

  it.each(["0.1.7-rc.3", "0.2.0-rc.1"])(
    "connects to newer DSH release %s without an exact-version gate",
    async (version) => {
      await withEnvironment({ DSH_FAKE_VERSION: version }, async () => {
        const connection = await connect();
        await connection.close();
      });
    },
  );

  it("registers the default dsh command and reports status from the resolved launch", async () => {
    const provider = createDeepSeekHarnessProvider();
    expect(provider.command).toEqual(["dsh", "--profile", "acp"]);
    await expect(provider.status?.({ launch: testLaunch() })).resolves.toEqual({
      available: true,
    });
    await withEnvironment({ DSH_FAKE_VERSION: "0.1.4" }, async () => {
      const status = await provider.status?.({ launch: testLaunch() });
      expect(status?.available).toBe(false);
      expect(status?.diagnostic).toContain("Unsupported DeepSeek Harness version 0.1.4");
    });
    const missing = await provider.status?.({ launch: testLaunch("/missing/dsh") });
    expect(missing?.available).toBe(false);
    expect(missing?.diagnostic).toContain("could not start executable /missing/dsh");
    await expect(provider.status?.({})).resolves.toEqual({
      available: false,
      diagnostic: expect.stringContaining("requires Paseo 0.11"),
    });
    await expect(
      provider.connect({ ...connectRequest(), launch: undefined }),
    ).rejects.toThrow("requires Paseo 0.11");
  });

  it("applies session variables over the launch environment", async () => {
    const logPath = join(testRoot, "launch-env.log");
    await writeFile(logPath, "");
    const resources = new Set<ConnectorResource>();
    const launch = testLaunch();
    launch.env.DSH_FAKE_SPAWN_LOG = logPath;
    launch.env.DSH_TEST_MARKER = "launch";
    const stream = await createDshAcpStream({
      launch,
      cwd: cwdA,
      env: { DSH_TEST_MARKER: "session" },
      resources,
    });
    try {
      const records = await waitForFakeSpawnLog(logPath, (current) =>
        current.some((record) => record.event === "start" && !record.args.includes("--version")),
      );
      const start = records.find(
        (record) => record.event === "start" && !record.args.includes("--version"),
      );
      expect(start?.args).toEqual(["--profile", "acp"]);
      expect(start?.marker).toBe("session");
    } finally {
      await stream.close();
    }
  });

  it("names the working directory when a spawn path is missing", async () => {
    const resources = new Set<ConnectorResource>();
    const cwd = join(testRoot, "missing-workspace");
    const error = await createDshAcpStream({
      launch: testLaunch(), cwd, env: {}, resources,
    }).then(
      () => { throw new Error("Expected missing-directory failure"); },
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(cwd);
    expect((error as Error).message).toContain("Check that both the executable and working directory exist");
    expect(resources.size).toBe(0);
  });

  it("redacts JSON credential fields from public-provider startup diagnostics", async () => {
    await withEnvironment(
      {
        DSH_FAKE_VERSION: "0.1.5-alpha.2",
        DSH_FAKE_VERSION_STDERR: '{"apiKey":"review-secret","reason":"synthetic diagnostic"}',
      },
      async () => {
        const provider = createDeepSeekHarnessProvider();
        try {
          const error = await provider.connect(connectRequest()).then(
            () => { throw new Error("Expected unsupported-version failure"); },
            (cause: unknown) => cause,
          );
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toContain("Unsupported DeepSeek Harness version");
          expect((error as Error).message).toContain("[redacted]");
          expect((error as Error).message).not.toContain("review-secret");
          expect((error as Error).message).toContain("synthetic diagnostic");
        } finally {
          await provider.dispose();
        }
      },
    );
  });

  it("reports a hung version probe as a timeout, not its cleanup signal", async () => {
    const logPath = join(testRoot, "version-timeout.log");
    await writeFile(logPath, "");
    await withEnvironment(
      { DSH_FAKE_HANG_VERSION: "1", DSH_FAKE_SPAWN_LOG: logPath },
      async () => {
        const provider = createDeepSeekHarnessProvider();
        try {
          await expect(provider.connect(connectRequest())).rejects.toThrow(
            "version probe timed out after 5000ms",
          );
          const records = await waitForFakeSpawnLog(logPath, allStartedExited);
          expect(records.filter((record) => record.event === "start")).toHaveLength(1);
          expect(records.find((record) => record.event === "start")?.args).toEqual([
            "--profile", "acp", "--version",
          ]);
        } finally {
          await provider.dispose();
        }
      },
    );
  }, 10_000);

  it("closes a version probe that is still waiting and does not spawn afterward", async () => {
    const resources = new Set<ConnectorResource>();
    let closed = false;
    const streamPromise = createDshAcpStream({
      launch: testLaunch(),
      cwd: testRoot,
      env: { DSH_FAKE_HANG_VERSION: "1" },
      resources,
      isClosed: () => closed,
    });
    await waitForCondition(() => resources.size > 0, 1_000);
    closed = true;
    await Promise.allSettled(
      [...resources].map((resource) =>
        resource.close(new Error("test closed version probe")),
      ),
    );
    await expect(streamPromise).rejects.toThrow(/closed|start|version/);
    expect(resources.size).toBe(0);
  });
});

/**
 * The daemon-resolved launch, with the environment as it is at call time.
 * The fake runs through Node so Windows does not need to execute a .mjs file.
 */
function testLaunch(command: string = process.execPath): ProviderLaunch {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return { command, args: [fakeDsh, "--profile", "acp"], env };
}

function connectRequest(): ProviderConnectRequest {
  return {
    launch: testLaunch(),
    versions: [1],
    capabilities: [
      "prompt.message",
      "prompt.command",
      "prompt.image",
      "session.configure",
      "session.list",
      "session.persistence",
      "permission",
      "prompt.steer",
    ],
  };
}

async function connect(
  options: DeepSeekHarnessProviderOptions = {},
): Promise<ReturnType<Awaited<ReturnType<typeof createDeepSeekHarnessProvider>>["connect"]>> {
  const provider = createDeepSeekHarnessProvider(options);
  return provider.connect(connectRequest());
}

function openInput(
  sessionId: string,
  cwd: string,
  marker: string,
  history: "replay" | "skip",
  persistence?: Extract<
    ProviderInput,
    { type: "session.open" }
  >["persistence"],
): Extract<ProviderInput, { type: "session.open" }> {
  return {
    type: "session.open",
    requestId: "open-" + sessionId + "-" + history,
    sessionId,
    config: {
      cwd,
      env: {
        DSH_TEST_MARKER: marker,
        DSH_HOME: join(testRoot, "dsh-home-" + marker),
      },
      systemPrompt: "test system prompt",
      mcpServers: {
        "test-mcp": {
          type: "stdio",
          command: "test-mcp",
          args: ["--keep"],
          env: { MCP_TEST: "yes" },
          alwaysLoad: true,
        },
      },
      settings: {},
      providerOptions: { untouched: true },
      model: modelFlash,
      thinkingOption: "off",
      persist: true,
    },
    persistence,
    history,
  };
}

function messagePrompt(
  sessionId: string,
  clientMessageId: string,
  text: string,
  extraContent: ProviderContent[] = [],
): Extract<ProviderInput, { type: "session.prompt" }> {
  return {
    type: "session.prompt",
    sessionId,
    prompt: {
      clientMessageId,
      delivery: "auto",
      input: {
        type: "message",
        content: [{ type: "text", text }, ...extraContent],
      },
    },
  };
}

async function closeSession(
  connection: Awaited<ReturnType<typeof connect>>,
  collector: EventCollector,
  sessionId: string,
  requestId: string,
): Promise<void> {
  await connection.send({
    type: "session.close",
    requestId,
    sessionId,
  });
  await collector.waitFor(
    (event) => event.type === "session.closed" && event.sessionId === sessionId,
  );
}

interface EventCollector {
  events: ProviderEvent[];
  waitFor(
    predicate: (event: ProviderEvent) => boolean,
    timeoutMs?: number,
    fromIndex?: number,
  ): Promise<ProviderEvent>;
  unsubscribe(): void;
}

async function waitForReady(
  collector: EventCollector,
  sessionId: string,
  timeoutMs = 3_000,
  fromIndex = 0,
): Promise<ProviderEvent> {
  const event = await collector.waitFor(
    (candidate) =>
      candidate.type === "session.ready" && candidate.sessionId === sessionId,
    timeoutMs,
    fromIndex,
  );
  // The public shim emits session.ready before it commits its session map.
  await new Promise<void>((resolve) => setImmediate(resolve));
  return event;
}

function collect(
  connection: Awaited<ReturnType<typeof connect>>,
): EventCollector {
  const events: ProviderEvent[] = [];
  const waiters: Array<{
    predicate: (event: ProviderEvent) => boolean;
    resolve: (event: ProviderEvent) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    fromIndex: number;
  }> = [];

  const unsubscribe = connection.onEvent((event) => {
    const parsed = ProviderEventSchema.parse(event);
    events.push(parsed);
    for (const waiter of waiters.slice()) {
      if (
        events.length - 1 >= waiter.fromIndex &&
        waiter.predicate(parsed)
      ) {
        clearTimeout(waiter.timer);
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(parsed);
      }
    }
  });

  return {
    events,
    waitFor(predicate, timeoutMs = 3_000, fromIndex = 0) {
      const existing = events
        .slice(fromIndex)
        .find((event) => predicate(event));
      if (existing) {
        return Promise.resolve(existing);
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          reject,
          fromIndex,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) {
              waiters.splice(index, 1);
            }
            reject(new Error("timed out waiting for provider event"));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
    unsubscribe,
  };
}

function settingValue(event: ProviderEvent, id: string): unknown {
  if (event.type !== "session.config") {
    return undefined;
  }
  return event.config.settings.find((setting) => setting.id === id)?.value;
}

async function withEnvironment(
  values: Record<string, string | undefined>,
  callback: () => Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function waitForCondition(
  condition: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for test condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Every logged fake process has exited. On Windows terminateProcess uses
 * taskkill /F, so a killed fake cannot log its own exit; check the PID instead.
 */
function allStartedExited(records: readonly FakeLogRecord[]): boolean {
  const starts = records.filter((record) => record.event === "start");
  return starts.length > 0 && starts.every((record) => !isRunning(record.pid));
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface FakeLogRecord {
  event: string;
  pid: number;
  args: string[];
  text?: string;
  marker?: string;
}

async function readFakeSpawnLog(path: string): Promise<FakeLogRecord[]> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch {
    return [];
  }
  return contents.split("\n").flatMap((line) => {
    if (!line) {
      return [];
    }
    try {
      return [JSON.parse(line) as FakeLogRecord];
    } catch {
      return [];
    }
  });
}

async function waitForFakeSpawnLog(
  path: string,
  predicate: (records: readonly FakeLogRecord[]) => boolean,
  timeoutMs = 3_000,
): Promise<FakeLogRecord[]> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const records = await readFakeSpawnLog(path);
    if (predicate(records)) {
      return records;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        "timed out waiting for fake DSH process log: " +
          JSON.stringify(records),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
