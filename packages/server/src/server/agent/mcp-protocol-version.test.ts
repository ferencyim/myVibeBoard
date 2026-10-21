import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { rejectUnsupportedMcpProtocolVersion } from "./mcp-protocol-version.js";

const NEW_REVISION = "2026-07-28";

describe("rejectUnsupportedMcpProtocolVersion", () => {
  test("passes requests without the header and with a supported version", () => {
    const body = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    expect(rejectUnsupportedMcpProtocolVersion(undefined, body)).toBeNull();
    expect(rejectUnsupportedMcpProtocolVersion("2025-11-25", body)).toBeNull();
  });

  test("leaves initialize to the SDK even when the header names a newer revision", () => {
    const body = { jsonrpc: "2.0", id: 1, method: "initialize" };
    expect(rejectUnsupportedMcpProtocolVersion(NEW_REVISION, body)).toBeNull();
  });

  test("answers a server/discover probe with the unsupported-version error", () => {
    const rejection = rejectUnsupportedMcpProtocolVersion(NEW_REVISION, {
      jsonrpc: "2.0",
      id: "server-discover-probe-1",
      method: "server/discover",
    });
    expect(rejection?.status).toBe(400);
    expect(rejection?.body.id).toBe("server-discover-probe-1");
    expect(rejection?.body.error.code).toBe(-32022);
    expect(rejection?.body.error.data.requested).toBe(NEW_REVISION);
    expect(rejection?.body.error.data.supported).toContain("2025-11-25");
    expect(rejection?.body.error.data.supported).not.toContain(NEW_REVISION);
  });
});

describe("agent MCP route with a 2026-07-28 client", () => {
  let httpServer: Server | null = null;
  afterEach(async () => {
    await new Promise<void>((resolve) =>
      httpServer ? httpServer.close(() => resolve()) : resolve(),
    );
    httpServer = null;
  });

  async function startRoute(transportErrors: Error[]): Promise<string> {
    const app = express();
    app.use(express.json());
    // Mirrors the stateless route in bootstrap.ts.
    const handle = async (req: express.Request, res: express.Response) => {
      const rejection = rejectUnsupportedMcpProtocolVersion(
        req.header("mcp-protocol-version"),
        req.body,
      );
      if (rejection) {
        res.status(rejection.status).json(rejection.body);
        return;
      }
      const mcp = new McpServer({ name: "test", version: "1.0.0" });
      mcp.registerTool("ping", { description: "ping" }, async () => ({
        content: [{ type: "text", text: "pong" }],
      }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      Object.assign(transport, { onerror: (error: Error) => transportErrors.push(error) });
      await mcp.connect(transport);
      res.on("close", () => void transport.close());
      await transport.handleRequest(req, res, req.body);
    };
    app.post("/mcp/agents", (req, res) => void handle(req, res));
    await new Promise<void>((resolve) => {
      httpServer = app.listen(0, "127.0.0.1", resolve);
    });
    return `http://127.0.0.1:${(httpServer!.address() as AddressInfo).port}/mcp/agents`;
  }

  test("the discover probe gets a fallback-friendly 400 and the SDK transport logs no error", async () => {
    const transportErrors: Error[] = [];
    const url = await startRoute(transportErrors);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": NEW_REVISION,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: "p1", method: "server/discover" }),
    });
    expect(response.status).toBe(400);
    const json = (await response.json()) as {
      error: { code: number; data: { supported: string[] } };
    };
    expect(json.error.code).toBe(-32022);
    expect(json.error.data.supported).not.toContain(NEW_REVISION);
    expect(transportErrors).toEqual([]);
  });

  test("after the probe the legacy handshake lists and calls tools", async () => {
    const transportErrors: Error[] = [];
    const url = await startRoute(transportErrors);
    await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": NEW_REVISION,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: "p1", method: "server/discover" }),
    });
    const client = new Client({ name: "probe-then-legacy", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["ping"]);
      const result = await client.callTool({ name: "ping", arguments: {} });
      expect(result.content).toEqual([{ type: "text", text: "pong" }]);
    } finally {
      await client.close();
    }
    expect(transportErrors).toEqual([]);
  });
});
