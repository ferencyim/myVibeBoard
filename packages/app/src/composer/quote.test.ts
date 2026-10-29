import { describe, expect, it, vi } from "vitest";
import {
  decodeComposerQuote,
  encodeComposerQuote,
  finishQuotedSubmission,
  restoreQuotedDraft,
} from "./quote";
import { submitAgentInput } from "./submit";
import {
  editQueuedComposerMessage,
  queueComposerMessage,
  type QueueWriter,
  type QueuedComposerMessage,
} from "./actions";

describe("composer quote", () => {
  it("round trips a multiline quote and message without losing its stable id", () => {
    const quote = { messageId: "message/1", author: "助手", text: "first\nsecond > line" };
    expect(decodeComposerQuote(encodeComposerQuote(quote, "answer"))).toEqual({
      quote,
      text: "answer",
    });
  });

  it("leaves ordinary and malformed text alone", () => {
    expect(decodeComposerQuote("> ordinary quote")).toBeNull();
    expect(decodeComposerQuote("<!-- paseo-quote:% -->\ninvalid")).toBeNull();
  });

  it("decodes an attachment-only submission after transport trimming", () => {
    const quote = { messageId: "1", author: "A", text: "quoted" };
    expect(decodeComposerQuote(encodeComposerQuote(quote, "").trim())).toEqual({ quote, text: "" });
  });

  it("bounds long excerpts without splitting Unicode characters", () => {
    const quote = { messageId: "1", author: "A", text: "😀".repeat(600) };
    const decoded = decodeComposerQuote(encodeComposerQuote(quote, "answer"));
    expect(decoded?.quote.text).toBe(`${"😀".repeat(500)}…`);
    expect(decoded?.quote.messageId).toBe("1");
  });
});

describe("quoted message submission", () => {
  const quote = { messageId: "source", author: "A", text: "original" };

  it("sends the encoded quote and clears it only after success", async () => {
    const outgoing = encodeComposerQuote(quote, "reply");
    const send = vi.fn(async (_input: { message: string; attachments: never[] }) => {});
    const clearQuote = vi.fn();
    const result = await submitAgentInput({
      message: outgoing,
      attachments: [],
      isAgentRunning: false,
      canSubmit: true,
      queueMessage: vi.fn(),
      submitMessage: send,
      clearDraft: vi.fn(),
      setUserInput: vi.fn(),
      setAttachments: vi.fn(),
      setSendError: vi.fn(),
      setIsProcessing: vi.fn(),
    });
    finishQuotedSubmission(result, quote, clearQuote);
    expect(decodeComposerQuote(send.mock.calls[0]?.[0].message ?? "")).toEqual({
      quote,
      text: "reply",
    });
    expect(clearQuote).toHaveBeenCalledWith(quote);
  });

  it("restores plain draft text and retains the chip on failure", async () => {
    const outgoing = encodeComposerQuote(quote, "reply");
    const setDraft = vi.fn();
    const clearQuote = vi.fn();
    const result = await submitAgentInput({
      message: outgoing,
      attachments: [],
      isAgentRunning: false,
      canSubmit: true,
      queueMessage: vi.fn(),
      submitMessage: async () => {
        throw new Error("failed");
      },
      clearDraft: vi.fn(),
      setUserInput: (value) => setDraft(restoreQuotedDraft(value, outgoing, quote)),
      setAttachments: vi.fn(),
      setSendError: vi.fn(),
      setIsProcessing: vi.fn(),
    });
    finishQuotedSubmission(result, quote, clearQuote);
    expect(setDraft).toHaveBeenLastCalledWith("reply");
    expect(clearQuote).not.toHaveBeenCalled();
  });

  it("retains the quote through queueing and editing", () => {
    let entries = new Map<string, QueuedComposerMessage[]>();
    const queue: QueueWriter = {
      read: (id) => entries.get(id) ?? [],
      write: (update) => {
        entries = update(entries);
      },
    };
    const queued = queueComposerMessage({
      agentId: "agent",
      text: encodeComposerQuote(quote, "reply"),
      attachments: [],
      queue,
    }).queued;
    expect(queued).not.toBeNull();
    const edited = editQueuedComposerMessage({ agentId: "agent", messageId: queued!.id, queue });
    expect(decodeComposerQuote(edited!.text)).toEqual({ quote, text: "reply" });
    expect(queue.read("agent")).toEqual([]);
  });
});
