import { MarkdownRenderer } from "@/components/markdown/renderer";

/** The app's shared Markdown engine for plugin UI; plugins pass text only. */
export function Markdown({ text, compact }: { text: string; compact?: boolean }) {
  return <MarkdownRenderer text={text} compact={compact} />;
}
