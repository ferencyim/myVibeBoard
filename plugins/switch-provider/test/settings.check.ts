import assert from "node:assert/strict";
import { compact, DEFAULT_COMPACT_OPTIONS, type Common } from "../server/compact";
import { DEFAULT_SUMMARY_ACK, DEFAULT_SUMMARY_HEADER, renderTemplate, switchSettings, textOrDefault } from "../shared/settings";

// Defaults equal the constants that used to be hard-coded.
const defaults = switchSettings.schema.parse({});
assert.equal(defaults.keepTurns, 10);
assert.equal(defaults.targetPercent, 60);
assert.equal(defaults.defaultWindowTokens, 200_000);
assert.equal(defaults.transcriptBlockCap, 20_000);
assert.equal(defaults.listCap, 40);
assert.equal(defaults.transcriptPage, 500);
assert.equal(defaults.transcriptMaxBlock, 20_000);
assert.equal(defaults.summaryAck, "明白。我会使用压缩后的历史；需要细节时再查看完整记录。");
assert.deepEqual(DEFAULT_COMPACT_OPTIONS.keepTurns, 10);

// The default header is the old text, with the title and the transcript path filled in.
const originalHeader = (title: string, path: string) =>
  [
    title,
    "",
    "本会话已切换到新的 provider，而它的历史记录超出了新模型的上下文窗口。",
    "较早的历史已压缩在下面：保留了你的消息和助手的文字，每个工具调用压成一行，错误完整保留。",
    `详细记录在 ${path}。每条记录的 [L<first>-L<last>] 指针标明它在该文件中的行范围；需要更多细节时，读取或搜索这些行。过长的工具块可能被截断；图片和推理过程已省略。`,
    "不要自行恢复、重复或完成之前的工作。等待用户的下一条消息，只回答那一条。",
    "",
  ].join("\n");
assert.equal(renderTemplate(DEFAULT_SUMMARY_HEADER, { title: "T", transcriptPath: "/p.md" }), originalHeader("T", "/p.md"));
assert.equal(textOrDefault("  ", "fallback"), "fallback");
assert.equal(renderTemplate("{{a}}{{a}} {{missing}}", { a: "{{b}}", b: "x" }), "{{b}}{{b}} ", "one pass: values are not scanned again");

// A long session: the settings reach the compacted history.
const filler = "x".repeat(40_000);
const messages: Common["messages"] = [];
for (let turn = 0; turn < 14; turn++) {
  messages.push({ role: "user", content: [{ type: "text", text: turn === 0 ? "Build the widget" : `step ${turn}` }] });
  messages.push({ role: "assistant", content: [{ type: "tool_use", id: `r${turn}`, tool: { name: "Raw", tool_name: "edit", input: { filePath: `/p/f${turn}.ts` } } }] });
  messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `r${turn}`, content: [{ type: "text", text: filler }] }] });
  messages.push({ role: "assistant", content: [{ type: "text", text: `done ${turn}` }] });
}
const common: Common = { meta: { id: "settings-check" }, messages };
const textOf = (m: Common["messages"][number]) => (m.content as Array<{ text?: string }>).map((b) => b.text ?? "").join("");
const first = (c: Common) => textOf(c.messages[0]);
const second = (c: Common) => textOf(c.messages[1]);
const turnsLeft = (c: Common) => c.messages.filter((m) => m.role === "user" && JSON.stringify(m).includes("step")).length;

const standard = await compact(common, 40_000);
assert.ok(standard, "compacted with the defaults");
assert.ok(first(standard.common).startsWith("Build the widget" + String.fromCharCode(10).repeat(2) + "本会话已切换到新的 provider"), "the title is the opening request");
assert.match(first(standard.common), /Files edited \(14 detected/);
assert.equal(second(standard.common), DEFAULT_SUMMARY_ACK);

const custom = await compact(common, 40_000, {
  ...DEFAULT_COMPACT_OPTIONS,
  keepTurns: 2,
  listCap: 3,
  summaryHeader: "{{title}} / custom header / {{transcriptPath}}",
  summaryAck: "Got it.",
});
assert.ok(custom, "compacted with custom options");
assert.match(first(custom.common), /Build the widget \/ custom header \//);
assert.doesNotMatch(first(custom.common), /本会话已切换到新的 provider/);
assert.equal(first(custom.common).split("Files edited")[1].split(String.fromCharCode(10)).filter((l) => l.startsWith("- /p/")).length, 3, "listCap cuts the file list");
assert.equal(second(custom.common), "Got it.");
assert.ok(turnsLeft(custom.common) <= turnsLeft(standard.common), "fewer turns are kept word for word");

// An empty text falls back to the default.
const blank = await compact(common, 40_000, { ...DEFAULT_COMPACT_OPTIONS, summaryHeader: "", summaryAck: " " });
assert.ok(blank);
assert.match(first(blank.common), /本会话已切换到新的 provider/);
assert.equal(second(blank.common), DEFAULT_SUMMARY_ACK);
console.log("switch-provider settings checks passed");
