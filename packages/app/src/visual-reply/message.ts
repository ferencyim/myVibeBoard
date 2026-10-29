export type VisualMessage = { type: "height"; height: number } | { type: "draft"; text: string };
export function parseVisualMessage(value: unknown): VisualMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.type === "height" &&
    Object.keys(record).length === 2 &&
    typeof record.height === "number" &&
    Number.isFinite(record.height)
  ) {
    return { type: "height", height: Math.max(80, Math.min(2000, Math.ceil(record.height))) };
  }
  if (
    record.type === "draft" &&
    Object.keys(record).length === 2 &&
    typeof record.text === "string" &&
    record.text.length <= 2000
  ) {
    return { type: "draft", text: record.text };
  }
  return null;
}
