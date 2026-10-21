import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";

/**
 * JSON-RPC code a server answers with when it cannot speak the protocol revision a request
 * names (MCP 2026-07-28 "unsupported version"); the data lists the revisions it does speak.
 */
const UNSUPPORTED_PROTOCOL_VERSION_CODE = -32022;

export interface McpVersionRejection {
  status: 400;
  body: {
    jsonrpc: "2.0";
    error: {
      code: number;
      message: string;
      data: { supported: string[]; requested: string };
    };
    id: string | number | null;
  };
}

function singleRequest(body: unknown): { method?: unknown; id?: unknown } | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  return body as { method?: unknown; id?: unknown };
}

/**
 * The agent MCP route is a legacy (2025-era) server. Newer clients (Claude Code 2.1.3xx) first
 * probe `server/discover` with `mcp-protocol-version: 2026-07-28` and fall back to the
 * `initialize` handshake when the server answers with a JSON-RPC error. The SDK transport also
 * answers that probe with a 400, but reports it through `onerror`, which the daemon logs at
 * error level on every connection. Answer it here instead, with the code and `supported` list
 * the newer clients use to pick a fallback revision.
 *
 * `initialize` is exempt: it carries no negotiated version yet and the SDK ignores the header there.
 */
export function rejectUnsupportedMcpProtocolVersion(
  header: string | undefined,
  body: unknown,
): McpVersionRejection | null {
  if (header === undefined || SUPPORTED_PROTOCOL_VERSIONS.includes(header)) return null;
  const request = singleRequest(body);
  if (request?.method === "initialize") return null;
  const id = typeof request?.id === "string" || typeof request?.id === "number" ? request.id : null;
  const supported = [...SUPPORTED_PROTOCOL_VERSIONS];
  return {
    status: 400,
    body: {
      jsonrpc: "2.0",
      error: {
        code: UNSUPPORTED_PROTOCOL_VERSION_CODE,
        message: `Bad Request: Unsupported protocol version: ${header} (supported versions: ${supported.join(", ")})`,
        data: { supported, requested: header },
      },
      id,
    },
  };
}
