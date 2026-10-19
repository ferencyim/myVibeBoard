import { describe, expect, it, vi } from "vitest";
import type {
  AcpStream,
  AcpStreamMessage,
} from "@getpaseo/plugin/server/acp";
import {
  assertSupportedNodeVersion,
  createAcpCompatibilityStream,
  extractDshVersion,
  isSupportedDshVersion,
  redactDiagnostic,
  type AcpStreamOwner,
} from "./dsh-compatibility";

interface MemoryTransport {
  source: AcpStream;
  input: ReadableStreamDefaultController<AcpStreamMessage>;
  writes: AcpStreamMessage[];
  owner: AcpStreamOwner;
  close: ReturnType<typeof vi.fn>;
}

function memoryTransport(): MemoryTransport {
  let input: ReadableStreamDefaultController<AcpStreamMessage> | undefined;
  const writes: AcpStreamMessage[] = [];
  const source: AcpStream = {
    readable: new ReadableStream<AcpStreamMessage>({
      start(controller) {
        input = controller;
      },
    }),
    writable: new WritableStream<AcpStreamMessage>({
      write(message) {
        writes.push(message);
      },
    }),
  };
  const close = vi.fn(async () => undefined);
  const owner: AcpStreamOwner = {
    close,
    onFailure() {
      return () => undefined;
    },
  };
  return {
    source,
    input: input as ReadableStreamDefaultController<AcpStreamMessage>,
    writes,
    owner,
    close,
  };
}

function frame(value: unknown): AcpStreamMessage {
  return value as AcpStreamMessage;
}

async function readMessage(
  reader: ReadableStreamDefaultReader<AcpStreamMessage>,
): Promise<AcpStreamMessage> {
  const result = await reader.read();
  if (result.done) {
    throw new Error("memory ACP stream ended");
  }
  return result.value;
}

async function handshake(
  transport: MemoryTransport,
  capabilities: Record<string, unknown>,
): Promise<{
  managed: ReturnType<typeof createAcpCompatibilityStream>;
  writer: WritableStreamDefaultWriter<AcpStreamMessage>;
  reader: ReadableStreamDefaultReader<AcpStreamMessage>;
}> {
  const managed = createAcpCompatibilityStream(
    transport.source,
    transport.owner,
  );
  const writer = managed.writable.getWriter();
  const reader = managed.readable.getReader();
  await writer.write(
    frame({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1 },
    }),
  );
  transport.input.enqueue(
    frame({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: 1,
        agentCapabilities: capabilities,
      },
    }),
  );
  await readMessage(reader);
  return { managed, writer, reader };
}

describe("DeepSeek ACP compatibility stream", () => {
  it("maps resume-only persistence and typed tool content without losing frames", async () => {
    const transport = memoryTransport();
    const sessionCapabilities = { resume: {}, list: {} };
    const { managed, writer, reader } = await handshake(transport, {
      promptCapabilities: { image: true },
      sessionCapabilities,
    });

    expect(transport.writes[0]).toEqual(
      frame({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1 },
      }),
    );

    const loadParams = {
      sessionId: "native-1",
      cwd: "/workspace",
      mcpServers: [
        {
          name: "test",
          command: "mcp-test",
          args: ["--full"],
          env: [{ name: "KEEP", value: "yes" }],
        },
      ],
      additionalDirectories: ["/workspace/extra"],
      _meta: { preserve: { nested: true } },
    };
    await writer.write(
      frame({
        jsonrpc: "2.0",
        id: 2,
        method: "session/load",
        params: loadParams,
      }),
    );
    expect(transport.writes[1]).toEqual(
      frame({
        jsonrpc: "2.0",
        id: 2,
        method: "session/resume",
        params: loadParams,
      }),
    );

    const content = [
      {
        type: "content",
        content: {
          type: "text",
          text: "first\n" + "x".repeat(20_000) + "\ntail-marker",
        },
      },
      {
        type: "diff",
        diff: { path: "file.txt", oldText: "a", newText: "b" },
      },
    ];
    const projected = frame({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "native-1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          status: "completed",
          content,
        },
      },
    });
    transport.input.enqueue(projected);
    expect(await readMessage(reader)).toEqual(
      frame({
        ...projected,
        params: {
          sessionId: "native-1",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-1",
            status: "completed",
            content,
            rawOutput: { content },
          },
        },
      }),
    );

    const existingOutput = frame({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "native-1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          content,
          rawOutput: null,
        },
      },
    });
    transport.input.enqueue(existingOutput);
    expect(await readMessage(reader)).toBe(existingOutput);

    const error = frame({
      jsonrpc: "2.0",
      id: 3,
      error: {
        code: -32001,
        message: "permission failed",
        data: { full: "payload", tail: "kept" },
      },
    });
    const permission = frame({
      jsonrpc: "2.0",
      id: "permission-1",
      method: "session/request_permission",
      params: {
        sessionId: "native-1",
        toolCall: { rawInput: { path: "full" } },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      },
    });
    const cancel = frame({
      jsonrpc: "2.0",
      method: "$/cancel_request",
      params: { requestId: "prompt-1", reason: "user" },
    });
    transport.input.enqueue(error);
    transport.input.enqueue(permission);
    transport.input.enqueue(cancel);
    expect(await readMessage(reader)).toBe(error);
    expect(await readMessage(reader)).toBe(permission);
    expect(await readMessage(reader)).toBe(cancel);

    await managed.close();
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it("does not rewrite a peer with native load support", async () => {
    const transport = memoryTransport();
    const { managed, writer } = await handshake(transport, {
      loadSession: true,
      sessionCapabilities: { list: {} },
    });
    const params = {
      sessionId: "native-2",
      cwd: "/workspace",
      mcpServers: [],
    };
    const load = frame({
      jsonrpc: "2.0",
      id: 4,
      method: "session/load",
      params,
    });
    await writer.write(load);
    expect(transport.writes[1]).toBe(load);
    await managed.close();
  });

  it("rejects unknown protocol state and malformed capability guards", async () => {
    const transport = memoryTransport();
    const managed = createAcpCompatibilityStream(
      transport.source,
      transport.owner,
    );
    const writer = managed.writable.getWriter();
    await expect(
      writer.write(
        frame({
          jsonrpc: "2.0",
          id: 5,
          method: "session/new",
          params: {},
        }),
      ),
    ).rejects.toThrow("non-initialize");
    await expect(managed.close()).resolves.toBeUndefined();

    const malformed = memoryTransport();
    const second = await handshakeStart(malformed);
    malformed.input.enqueue(
      frame({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: 1,
          agentCapabilities: { sessionCapabilities: { resume: true } },
        },
      }),
    );
    await expect(second.reader.read()).rejects.toThrow(
      "invalid session/resume capability",
    );
    await second.managed.close();
  });

  it("rejects session/load when the initialized peer has no compatible lifecycle", async () => {
    const transport = memoryTransport();
    const { managed, writer } = await handshake(transport, {
      sessionCapabilities: { list: {} },
    });
    await expect(
      writer.write(
        frame({
          jsonrpc: "2.0",
          id: 6,
          method: "session/load",
          params: {
            sessionId: "native-3",
            cwd: "/workspace",
            mcpServers: [],
          },
        }),
      ),
    ).rejects.toThrow("did not advertise session/resume");
    await managed.close();
  });
});

async function handshakeStart(transport: MemoryTransport): Promise<{
  managed: ReturnType<typeof createAcpCompatibilityStream>;
  reader: ReadableStreamDefaultReader<AcpStreamMessage>;
}> {
  const managed = createAcpCompatibilityStream(
    transport.source,
    transport.owner,
  );
  const writer = managed.writable.getWriter();
  const reader = managed.readable.getReader();
  await writer.write(
    frame({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    }),
  );
  return { managed, reader };
}

describe("DeepSeek Harness launch guards", () => {
  it.each([
    '{"apiKey":"review-secret","safe":"kept"}',
    '{"DEEPSEEK_API_KEY":"review-secret"}',
    "API key: review-secret",
    "'token': 'review-secret'",
    JSON.stringify({ password: 'escaped " quote: review-secret' }),
  ])("redacts quoted or spaced credential labels: %s", (input) => {
    const diagnostic = redactDiagnostic(input);
    expect(diagnostic).toContain("[redacted]");
    expect(diagnostic).not.toContain("review-secret");
  });

  it.each([
    "0.1.5-rc.1", "0.1.5-rc.2", "0.1.5-rc.3", "0.1.5-rc.10", "0.1.5",
    "0.1.6-alpha.1", "0.1.6-alpha.2", "0.1.6",
    "0.1.7-alpha.2", "0.1.7-alpha.2+custom.1", "0.1.7-rc.1", "0.1.7-rc.2",
    "0.1.7-rc.2+custom.1", "0.1.7-rc.3", "0.1.7",
    "0.2.0-rc.1", "0.2.0", "1.0.0-alpha.1", "10.0.0",
  ])("accepts %s at or above the minimum DSH version", (version) => {
    expect(isSupportedDshVersion(version)).toBe(true);
  });

  it.each([
    "0.1.5-rc.0", "0.1.5-rc", "0.1.5-beta.9", "0.1.5-alpha.2", "0.1.4", "0.1.2-rc.1",
    "0.0.1-rc.5", "0.1.5-RC.2", "01.2.3", "0.1", "dsh", "",
  ])("rejects %s below the minimum or unparseable", (version) => {
    expect(isSupportedDshVersion(version)).toBe(false);
  });

  it("extracts DSH versions from command output", () => {
    expect(isSupportedDshVersion(undefined)).toBe(false);
    expect(extractDshVersion("dsh 0.1.6")).toBe("0.1.6");
    expect(extractDshVersion("dsh 0.2.0-rc.1")).toBe("0.2.0-rc.1");
    expect(extractDshVersion("dsh 0.1.5-rc.2+custom.1")).toBe("0.1.5-rc.2+custom.1");
    expect(extractDshVersion("0.1.5-rc.2_not-a-version")).toBeUndefined();
    expect(extractDshVersion("version: 0.1.5-rc.2\n")).toBe("0.1.5-rc.2");
    expect(extractDshVersion("no version here")).toBeUndefined();
  });

  it("enforces the DSH Node requirement and redacts diagnostics", () => {
    expect(() => assertSupportedNodeVersion("22.19.0")).not.toThrow();
    expect(() => assertSupportedNodeVersion("24.0.0")).not.toThrow();
    expect(() => assertSupportedNodeVersion("22.18.9")).toThrow("22.19.0");
    expect(() => assertSupportedNodeVersion("21.9.0")).toThrow("22.19.0");
    const diagnostic = redactDiagnostic(
      "apiKey=secret-value Authorization: Bearer abc123; ordinary detail",
    );
    expect(diagnostic).toContain("apiKey=[redacted]");
    expect(diagnostic).toContain("Authorization: [redacted]");
    expect(diagnostic).not.toContain("secret-value");
    expect(diagnostic).not.toContain("abc123");
  });
});
