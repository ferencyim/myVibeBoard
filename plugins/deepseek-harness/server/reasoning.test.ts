import assert from "node:assert/strict";
import { setImmediate, setTimeout } from "node:timers/promises";
import { it } from "vitest";
import {
  runAcpProvider,
  type AcpStream,
  type AcpStreamMessage,
} from "@getpaseo/plugin/server/acp";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { createAcpCompatibilityStream } from "./dsh-compatibility";

const messageId = "11111111-1111-4111-8111-111111111111";
type Chunk = {
  sessionUpdate: "agent_thought_chunk" | "agent_message_chunk";
  messageId?: string;
  content: { type: "text"; text: string };
};
type Mode = "new" | "load" | "resume";

function chunk(kind: "thought" | "message", text: string, id?: string): Chunk {
  return {
    sessionUpdate: kind === "thought" ? "agent_thought_chunk" : "agent_message_chunk",
    ...(id === undefined ? {} : { messageId: id }),
    content: { type: "text", text },
  };
}

function notification(update: unknown): AcpStreamMessage {
  return {
    jsonrpc: "2.0", method: "session/update",
    params: { sessionId: "native", update },
  };
}

function capabilities(mode: Mode) {
  return mode === "resume"
    ? { sessionCapabilities: { resume: {} } }
    : { loadSession: true };
}

function memoryPeer(onWrite: (frame: AcpStreamMessage) => void = () => {}) {
  let controller!: ReadableStreamDefaultController<AcpStreamMessage>;
  const source: AcpStream = {
    readable: new ReadableStream({ start(c) { controller = c; } }),
    writable: new WritableStream({ write: onWrite }),
  };
  const stream = createAcpCompatibilityStream(source, {
    close: async () => {}, onFailure: () => () => {},
  });
  return { stream, emit: (frame: AcpStreamMessage) => controller.enqueue(frame) };
}

async function replay(chunks: Chunk[], mode: Mode = "new") {
  const peers: ReturnType<typeof memoryPeer>[] = [];
  const requests: string[] = [];
  const provider = runAcpProvider({
    id: "reasoning-repro", label: "Reasoning regression",
    connector() {
      const peer = memoryPeer((frame) => {
        if (!("method" in frame) || !("id" in frame)) return;
        requests.push(frame.method);
        const respond = (result: unknown) => peer.emit({ jsonrpc: "2.0", id: frame.id, result });
        switch (frame.method) {
          case "initialize":
            respond({ protocolVersion: 1, agentCapabilities: capabilities(mode) });
            break;
          case "session/new":
            respond({ sessionId: "native" });
            break;
          case "session/load":
          case "session/resume":
            respond({});
            break;
          case "session/prompt":
            for (const update of chunks) peer.emit(notification(update));
            respond({ stopReason: "end_turn" });
            break;
          default:
            respond({});
        }
      });
      peers.push(peer);
      return peer.stream;
    },
  });
  const connection = await provider.connect({
    versions: [1], capabilities: ["prompt.message", "session.persistence"],
  });
  const events: ProviderEvent[] = [];
  const unsubscribe = connection.onEvent((event) => events.push(event));
  async function waitFor(predicate: (event: ProviderEvent) => boolean) {
    const deadline = Date.now() + 3_000;
    while (!events.some(predicate)) {
      assert(Date.now() < deadline, "Timed out: " + JSON.stringify(events));
      await setTimeout(5);
    }
    // The SDK commits its session map after emitting session.ready.
    await setImmediate();
  }
  try {
    await connection.send({
      type: "session.open", requestId: "open", sessionId: "boundary", history: "replay",
      config: { cwd: process.cwd(), env: {}, settings: {}, mcpServers: {}, persist: true },
      ...(mode === "new" ? {} : { persistence: { version: 1, data: { sessionId: "native" } } }),
    });
    await waitFor((event) => event.type === "session.ready");
    await connection.send({
      type: "session.prompt", sessionId: "boundary", prompt: {
        clientMessageId: "prompt", delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "?" }] },
      },
    });
    await waitFor((event) => event.type === "session.turn" && event.state === "completed");
    return {
      requests,
      items: events.flatMap((event) => event.type === "timeline.item" &&
        (event.item.type === "reasoning" || event.item.type === "assistant_message")
        ? [event.item] : []),
    };
  } finally {
    unsubscribe();
    await connection.close();
    await Promise.all(peers.map((peer) => peer.stream.close()));
  }
}

for (const mode of ["new", "load", "resume"] as const) {
  it(`separates shared-ID reasoning and answer through the real SDK (${mode})`, async () => {
    const { items, requests } = await replay([
      chunk("thought", "Thinking.", messageId), chunk("message", "Answer.", messageId),
    ], mode);
    assert.deepEqual(items.map((item) => [item.type, item.text]), [
      ["reasoning", "Thinking."], ["assistant_message", "Answer."],
    ]);
    assert.notEqual(items[0].id, items[1].id);
    assert.equal(items[1].id, messageId);
    assert(items[1].type === "assistant_message");
    assert.equal(items[1].messageId, messageId);
    assert(requests.includes(mode === "new" ? "session/new" : `session/${mode}`));
  });
}

for (const interleaved of [false, true]) {
  it(`keeps incremental text and stable IDs with interleaved=${interleaved}`, async () => {
    const thoughts = [chunk("thought", "Think", messageId), chunk("thought", "ing.", messageId)];
    const answers = [chunk("message", "An", messageId), chunk("message", "swer.", messageId)];
    const updates = interleaved
      ? [thoughts[0], answers[0], thoughts[1], answers[1]]
      : [...thoughts, ...answers];
    const { items } = await replay(updates);
    const reasoning = items.filter((item) => item.type === "reasoning");
    const messages = items.filter((item) => item.type === "assistant_message");
    assert.deepEqual(reasoning.map((item) => item.text), ["Think", "Thinking."]);
    assert.deepEqual(messages.map((item) => item.text), ["An", "Answer."]);
    assert.equal(reasoning[0].id, reasoning[1].id);
    assert.notEqual(reasoning[0].id, messageId);
    assert(messages.every((item) => item.id === messageId && item.messageId === messageId));
    assert.deepEqual(items.map((item) => item.type), interleaved
      ? ["reasoning", "assistant_message", "reasoning", "assistant_message"]
      : ["reasoning", "reasoning", "assistant_message", "assistant_message"]);
  });
}

it("retains SDK grouping and kind boundaries for chunks without IDs", async () => {
  const { items } = await replay([
    chunk("thought", "Think"), chunk("thought", "ing."),
    chunk("message", "An"), chunk("message", "swer."),
    chunk("thought", "Again."), chunk("message", "Next."),
  ]);
  assert.deepEqual(items.map((item) => [item.type, item.text]), [
    ["reasoning", "Think"], ["reasoning", "Thinking."],
    ["assistant_message", "An"], ["assistant_message", "Answer."],
    ["reasoning", "Again."], ["assistant_message", "Next."],
  ]);
  assert.equal(items[0].id, items[1].id);
  assert.equal(items[2].id, items[3].id);
  assert.equal(new Set([items[0].id, items[2].id, items[4].id, items[5].id]).size, 4);
  assert(items.every((item) => item.type !== "assistant_message" || item.messageId === undefined));
});

async function bridge(mode: Mode) {
  const writes: AcpStreamMessage[] = [];
  const peer = memoryPeer((frame) => { writes.push(frame); });
  const writer = peer.stream.writable.getWriter();
  const reader = peer.stream.readable.getReader();
  await writer.write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
  peer.emit({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1, agentCapabilities: capabilities(mode) } });
  await reader.read();
  return { ...peer, writer, reader, writes };
}

for (const mode of ["load", "resume"] as const) {
  it(`projects history during pending session/${mode} exactly as live chunks`, async () => {
    const peer = await bridge(mode);
    try {
      const input = notification(chunk("thought", "Thinking.", messageId));
      const answer = notification(chunk("message", "Answer.", messageId));
      peer.emit(input);
      const live = (await peer.reader.read()).value;
      const expected = notification(chunk("thought", "Thinking.", messageId + ":thought"));
      assert.deepEqual(live, expected);
      await peer.writer.write({
        jsonrpc: "2.0", id: 2, method: "session/load",
        params: { sessionId: "native", cwd: process.cwd(), mcpServers: [] },
      });
      assert.equal((peer.writes.at(-1) as { method: string }).method, `session/${mode}`);
      // A native-load peer may replay updates before acknowledging the load.
      // Current DSH resume does not replay, but any incoming updates use this path.
      peer.emit(input);
      peer.emit(answer);
      assert.deepEqual((await peer.reader.read()).value, live);
      assert.equal((await peer.reader.read()).value, answer);
      peer.emit({ jsonrpc: "2.0", id: 2, result: {} });
      assert.deepEqual((await peer.reader.read()).value, { jsonrpc: "2.0", id: 2, result: {} });
    } finally {
      await peer.stream.close();
    }
  });
}

it("rewrites only thought IDs and preserves content, metadata, and malformed/absent IDs", async () => {
  const peer = await bridge("new");
  try {
    const content = { type: "text", text: "思考\n" + "x".repeat(20_000), _meta: { preserve: true } };
    const update = { ...chunk("thought", "", messageId), content, _meta: { extra: 1 } };
    const input = notification(update);
    peer.emit(input);
    assert.deepEqual((await peer.reader.read()).value, notification({ ...update, messageId: messageId + ":thought" }));
    assert.equal(update.messageId, messageId);
    assert.equal(update.content, content);
    const unchanged = [
      ...[undefined, null, "", 42, {}, []].map((id) => notification({ ...update, messageId: id })),
      notification(chunk("message", "Answer.", messageId)),
      notification({ ...update, sessionUpdate: "user_message_chunk" }),
      notification({ ...update, sessionUpdate: "tool_call" }),
      notification(null),
      { ...input, id: 99 }, // A request is not a session-update notification.
      { ...input, method: "vendor/update" },
    ];
    for (const frame of unchanged) {
      peer.emit(frame);
      assert.equal((await peer.reader.read()).value, frame);
    }
  } finally {
    await peer.stream.close();
  }
});
