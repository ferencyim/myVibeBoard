import { describe, expect, it, vi } from "vitest";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { visualReplyInputSchema } from "../shared/visual-reply";
import { registerVisualReply } from "../server/visual-reply";

vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(), writeFile: vi.fn(), readFile: vi.fn().mockResolvedValue("<p>hello</p>") }));

describe("visual replies", () => {
  it("stores HTML and appends an attachment locator", async () => {
    const { writeFile } = await import("node:fs/promises");
    const append = vi.fn();
    let tool: { handler(input: unknown, ctx: { callerAgentId: string }): Promise<unknown> } | undefined;
    const server = { handle: vi.fn(), registerAgentTool: (value: typeof tool) => { tool = value; }, paseo: { agents: { ref: () => ({ timeline: { append } }) } } } as unknown as PluginServerContext;
    registerVisualReply(server, async () => ({}));
    const result = await tool!.handler({ title: "  chart  ", html: "<p>hello</p>", height: 300 }, { callerAgentId: "agent" });
    expect(writeFile).toHaveBeenCalledWith(expect.stringMatching(/\.html$/), "<p>hello</p>", expect.objectContaining({ flag: "wx" }));
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ kind: "visual-reply", data: expect.objectContaining({ title: "chart", height: 300 }) }));
    expect(result).toEqual(expect.objectContaining({ mimeType: "text/html" }));
    expect(visualReplyInputSchema.safeParse({ title: "x", html: "x", height: 2001 }).success).toBe(false);
    expect(visualReplyInputSchema.safeParse({ title: "x", html: "x".repeat(512001) }).success).toBe(false);
  });
});
