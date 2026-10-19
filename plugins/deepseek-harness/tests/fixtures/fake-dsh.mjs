#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const spawnLog = process.env.DSH_FAKE_SPAWN_LOG;

function log(event, fields = {}) {
  if (!spawnLog) {
    return;
  }
  try {
    appendFileSync(
      spawnLog,
      JSON.stringify({ event, pid: process.pid, args, ...fields }) + "\n",
    );
  } catch {
    // Test diagnostics must not change the fake peer's protocol behavior.
  }
}

log("start", { marker: process.env.DSH_TEST_MARKER });
process.once("exit", () => log("exit", { exitCode: process.exitCode ?? 0 }));
process.once("SIGTERM", () => {
  log("signal", { signal: "SIGTERM" });
  const delay = Number(process.env.DSH_FAKE_SIGTERM_DELAY_MS ?? "0");
  if (Number.isFinite(delay) && delay > 0) {
    setTimeout(() => process.exit(143), delay);
  } else {
    process.exit(143);
  }
});

if (args.includes("--version")) {
  if (process.env.DSH_FAKE_HANG_VERSION === "1") {
    setInterval(() => undefined, 1_000);
    await new Promise(() => undefined);
  }
  process.stdout.write((process.env.DSH_FAKE_VERSION ?? "0.1.5-rc.1") + "\n");
  if (process.env.DSH_FAKE_VERSION_STDERR) {
    process.stderr.write(process.env.DSH_FAKE_VERSION_STDERR + "\n");
  }
  process.exit(0);
}

const expectedProfile = process.env.DSH_FAKE_EXPECTED_PROFILE ?? "acp";
if (args[0] !== "--profile" || args[1] !== expectedProfile) {
  process.stderr.write("expected profile " + expectedProfile + "\n");
  process.exit(2);
}

const capabilityMode = process.env.DSH_FAKE_CAPABILITIES ?? "resume";
const modelFlash = '["deepseek-official","deepseek-v4-flash"]';
const modelPro = '["deepseek-official","deepseek-v4-pro"]';
const sessions = new Map();
const pendingPrompts = new Map();
const pendingPermissions = new Map();
let sequence = 0;
let outputEnded = false;

function send(message) {
  if (!outputEnded) {
    process.stdout.write(JSON.stringify(message) + "\n");
  }
}

function response(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function errorResponse(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) {
    error.data = data;
  }
  send({ jsonrpc: "2.0", id, error });
}

function update(sessionId, value) {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update: value },
  });
}

function capabilities() {
  const sessionCapabilities = {
    list: {},
    close: {},
  };
  if (capabilityMode === "resume") {
    sessionCapabilities.resume = {};
  }
  const result = {
    promptCapabilities: { image: true },
    sessionCapabilities,
  };
  if (capabilityMode === "load") {
    result.loadSession = true;
  }
  return result;
}

function configOptions(session) {
  const marker = process.env.DSH_TEST_MARKER ?? "missing";
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: session.model,
      options: [
        { value: modelFlash, name: "DeepSeek V4 Flash" },
        { value: modelPro, name: "DeepSeek V4 Pro" },
      ],
    },
    {
      id: "reasoning_effort",
      name: "Reasoning effort",
      category: "thought_level",
      type: "select",
      currentValue: session.thinking,
      options: [
        { value: "off", name: "Off" },
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
        { value: "max", name: "Max" },
      ],
    },
    {
      id: "_fake_marker",
      name: "Test environment marker",
      category: "_test",
      type: "select",
      currentValue: marker,
      options: [{ value: marker, name: marker }],
    },
    {
      id: "_fake_lifecycle",
      name: "Test lifecycle",
      category: "_test",
      type: "select",
      currentValue: session.lifecycle,
      options: [
        { value: "new", name: "New" },
        { value: "resumed", name: "Resumed" },
        { value: "loaded", name: "Loaded" },
      ],
    },
  ];
}

function sessionFor(id) {
  const session = sessions.get(id);
  if (!session) {
    throw new Error("unknown session " + id);
  }
  return session;
}

function promptText(prompt) {
  if (!Array.isArray(prompt)) {
    return "";
  }
  return prompt
    .filter((part) => part && part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function hasImage(prompt) {
  return (
    Array.isArray(prompt) &&
    prompt.some((part) => part && part.type === "image")
  );
}

function sendUsage(sessionId) {
  update(sessionId, {
    sessionUpdate: "usage_update",
    used: 123,
    size: 8192,
    cost: { currency: "USD", amount: 0.01 },
  });
}

function sendAssistant(sessionId, text, messageId) {
  update(sessionId, {
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "thought for " + messageId },
  });
  update(sessionId, {
    sessionUpdate: "agent_message_chunk",
    messageId,
    content: { type: "text", text },
  });
}

function finishPrompt(requestId, sessionId, text, prompt) {
  const session = sessionFor(sessionId);
  sendUsage(sessionId);

  if (text.includes("tool")) {
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "long-tool",
      title: "raw_tool",
      name: "raw_tool",
      kind: "other",
      status: "in_progress",
      rawInput: { request: "tool", marker: process.env.DSH_TEST_MARKER ?? "missing" },
    });
    const longOutput = "tool-output-start\n" + "x".repeat(24_000) + "\ntool-output-tail";
    update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "long-tool",
      status: "completed",
      content: [
        {
          type: "content",
          content: { type: "text", text: longOutput },
        },
      ],
    });
  }

  const flags = [
    "marker=" + (process.env.DSH_TEST_MARKER ?? "missing"),
    "cwd=" + process.cwd(),
    "mcp=" + (session.mcpServers.some((server) => server.name === "test-mcp") ? "yes" : "no"),
    "image=" + (hasImage(prompt) ? "yes" : "no"),
    "lifecycle=" + session.lifecycle,
  ];
  sendAssistant(sessionId, flags.join(";"), "assistant-" + requestId);
  response(requestId, { stopReason: "end_turn" });
}

function startPermission(requestId, sessionId) {
  const permissionId = "permission-request-" + requestId;
  pendingPermissions.set(permissionId, { requestId, sessionId });
  send({
    jsonrpc: "2.0",
    id: permissionId,
    method: "session/request_permission",
    params: {
      sessionId,
      toolCall: {
        toolCallId: "permission-tool",
        title: "Permission test",
        name: "write_file",
        kind: "edit",
        status: "in_progress",
        rawInput: { path: "fixture.txt" },
      },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject once", kind: "reject_once" },
      ],
    },
  });
}

function prompt(requestId, params) {
  sessionFor(params.sessionId);
  const text = promptText(params.prompt);
  log("prompt", { requestId, text });
  if (text.includes("hang")) {
    pendingPrompts.set(requestId, {
      requestId,
      sessionId: params.sessionId,
      prompt: params.prompt,
    });
    return;
  }
  if (text.includes("eof")) {
    setImmediate(() => {
      outputEnded = true;
      process.stdout.end(() => process.exit(0));
    });
    return;
  }
  if (text.includes("permission")) {
    pendingPrompts.set(requestId, {
      requestId,
      sessionId: params.sessionId,
      prompt: params.prompt,
    });
    startPermission(requestId, params.sessionId);
    return;
  }
  if (text.includes("error")) {
    errorResponse(requestId, -32001, "fake prompt failure", {
      marker: process.env.DSH_TEST_MARKER ?? "missing",
      preserved: true,
    });
    return;
  }
  finishPrompt(requestId, params.sessionId, text, params.prompt);
}

function cancelSession(sessionId) {
  for (const [requestId, pending] of pendingPrompts) {
    if (pending.sessionId !== sessionId) {
      continue;
    }
    pendingPrompts.delete(requestId);
    response(requestId, { stopReason: "cancelled" });
  }
}

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (
    message.method === undefined &&
    message.id !== undefined &&
    pendingPermissions.has(message.id)
  ) {
    const pending = pendingPermissions.get(message.id);
    pendingPermissions.delete(message.id);
    pendingPrompts.delete(pending.requestId);
    update(pending.sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "permission-tool",
      status: "completed",
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: "permission response received",
          },
        },
      ],
    });
    finishPrompt(
      pending.requestId,
      pending.sessionId,
      "permission completed",
      pending.prompt,
    );
    return;
  }

  if (message.method === "initialize") {
    if (process.env.DSH_FAKE_NO_INITIALIZE === "1") {
      return;
    }
    response(message.id, {
      protocolVersion: 1,
      agentCapabilities: capabilities(),
      agentInfo: { name: "fake-dsh", version: "0.1.5-rc.1" },
    });
    return;
  }
  if (message.method === "session/new") {
    const sessionId = "fresh-" + process.pid + "-" + ++sequence;
    const session = {
      id: sessionId,
      cwd: message.params.cwd,
      mcpServers: message.params.mcpServers ?? [],
      lifecycle: "new",
      model: modelFlash,
      thinking: "off",
    };
    sessions.set(sessionId, session);
    response(message.id, {
      sessionId,
      configOptions: configOptions(session),
    });
    return;
  }
  if (message.method === "session/load" || message.method === "session/resume") {
    const sessionId = message.params.sessionId;
    const lifecycle = message.method === "session/resume" ? "resumed" : "loaded";
    const session = {
      id: sessionId,
      cwd: message.params.cwd,
      mcpServers: message.params.mcpServers ?? [],
      lifecycle,
      model: modelFlash,
      thinking: "off",
    };
    sessions.set(sessionId, session);
    response(message.id, { configOptions: configOptions(session) });
    return;
  }
  if (message.method === "session/list") {
    response(message.id, {
      sessions: [
        {
          sessionId: "listed-" + process.pid,
          cwd: message.params?.cwd ?? process.cwd(),
          title: "Listed fake session",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    return;
  }
  if (message.method === "session/set_config_option") {
    const session = sessionFor(message.params.sessionId);
    if (message.params.configId === "model") {
      session.model = message.params.value;
    } else if (message.params.configId === "reasoning_effort") {
      session.thinking = message.params.value;
    }
    response(message.id, { configOptions: configOptions(session) });
    return;
  }
  if (message.method === "session/prompt") {
    prompt(message.id, message.params);
    return;
  }
  if (message.method === "session/cancel") {
    cancelSession(message.params.sessionId);
    response(message.id, {});
    return;
  }
  if (message.method === "session/close") {
    cancelSession(message.params.sessionId);
    response(message.id, {});
    return;
  }
  if (
    message.method === "session/request_permission" ||
    message.method === "$/cancel_request"
  ) {
    return;
  }
  if (
    message.id !== undefined &&
    message.method !== undefined &&
    message.method !== "session/update"
  ) {
    errorResponse(message.id, -32601, "unsupported method", {
      method: message.method,
    });
  }
});

input.on("close", () => {
  outputEnded = true;
});
