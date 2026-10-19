import type { PluginBytesDocument, PluginTextDocument } from "@getpaseo/plugin/client";

export function textDocument(text: string, setText?: (text: string) => void): PluginTextDocument {
  return {
    kind: "text",
    text,
    editable: Boolean(setText),
    setText(next) {
      setText?.(next);
    },
  };
}

export function bytesDocument(bytes: Uint8Array, url: string): PluginBytesDocument {
  return { kind: "bytes", bytes, url };
}
