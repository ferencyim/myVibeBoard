export interface ComposerQuote {
  messageId: string;
  author: string;
  text: string;
}

export function truncateComposerQuote(quote: ComposerQuote): ComposerQuote {
  const characters = Array.from(quote.text);
  return characters.length > 500
    ? { ...quote, text: `${characters.slice(0, 500).join("")}…` }
    : quote;
}

function quotePrefix(quote: ComposerQuote): string {
  const marker = encodeURIComponent(JSON.stringify(quote));
  const excerpt = quote.text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `<!-- paseo-quote:${marker} -->\n${excerpt}\n\n`;
}

export function encodeComposerQuote(quote: ComposerQuote, text: string): string {
  return quotePrefix(truncateComposerQuote(quote)) + text;
}

export function restoreQuotedDraft(
  value: string,
  outgoing: string,
  quote?: ComposerQuote | null,
): string {
  return quote && value === outgoing.trim()
    ? outgoing.slice(encodeComposerQuote(quote, "").length).trim()
    : value;
}

export function finishQuotedSubmission(
  result: "noop" | "queued" | "submitted" | "failed",
  quote: ComposerQuote | null | undefined,
  clear: ((quote: ComposerQuote) => void) | undefined,
): void {
  if (quote && (result === "submitted" || result === "queued")) clear?.(quote);
}

export function decodeComposerQuote(text: string): { quote: ComposerQuote; text: string } | null {
  const match = /^<!-- paseo-quote:([^ ]+) -->\n/.exec(text);
  if (!match) return null;
  try {
    const value: unknown = JSON.parse(decodeURIComponent(match[1]));
    if (!value || typeof value !== "object") return null;
    const quote = value as Partial<ComposerQuote>;
    if (
      typeof quote.messageId !== "string" ||
      !quote.messageId ||
      typeof quote.author !== "string" ||
      typeof quote.text !== "string"
    )
      return null;
    const prefix = quotePrefix(quote as ComposerQuote);
    if (text === prefix.trimEnd()) return { quote: quote as ComposerQuote, text: "" };
    return text.startsWith(prefix)
      ? { quote: quote as ComposerQuote, text: text.slice(prefix.length) }
      : null;
  } catch {
    return null;
  }
}
