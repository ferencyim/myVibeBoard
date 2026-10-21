import { describe, expect, it } from "vitest";
import { AUTOMATION_LINKS, editorText, groupByRole, sourceIn, textToSave, unknownIn, type BehaviourPrompt } from "../client/behaviour/logic";

const p = (over: Partial<BehaviourPrompt> = {}): BehaviourPrompt => ({
  key: "x.a",
  plugin: "x",
  role: "master",
  title: "A",
  description: "",
  whenSent: "",
  audience: "",
  defaultText: "default {{n}}",
  placeholders: [{ name: "n", description: "" }],
  fixedSuffix: "",
  order: 0,
  globalOverride: null,
  projectOverride: null,
  source: "default",
  effectiveText: "default {{n}}",
  overriddenProjects: [],
  ...over,
});

describe("agent behaviour page logic", () => {
  it("groups by role in the fixed order, unknown roles last, empty groups hidden", () => {
    const groups = groupByRole([p({ key: "b", role: "watchdog" }), p({ key: "a", role: "master" }), p({ key: "c", role: "zzz" })]);
    expect(groups.map((g) => g.role)).toEqual(["master", "watchdog", "zzz"]);
    expect(groups[0]!.label).toBe("总 agent");
  });

  it("the editor shows the scope's own text, else what it inherits", () => {
    const prompt = p({ globalOverride: "G", projectOverride: "P" });
    expect(editorText(prompt, null)).toBe("G");
    expect(editorText(prompt, "proj")).toBe("P");
    expect(editorText(p({ globalOverride: "G" }), "proj")).toBe("G");
    expect(editorText(p(), "proj")).toBe("default {{n}}");
    expect(sourceIn(p({ globalOverride: "G" }), "proj")).toBe("global");
    expect(sourceIn(p({ globalOverride: "G", projectOverride: "P" }), "proj")).toBe("project");
    expect(sourceIn(p(), null)).toBe("default");
  });

  it("saving the inherited text stores no override", () => {
    expect(textToSave(p(), null, "default {{n}}")).toBe("");
    expect(textToSave(p({ globalOverride: "G" }), "proj", "G")).toBe("");
    expect(textToSave(p(), null, "mine")).toBe("mine");
  });

  it("flags unknown placeholders only for prompts that declare some", () => {
    expect(unknownIn(p(), "{{n}} {{typo}}")).toEqual(["typo"]);
    expect(unknownIn(p({ placeholders: [] }), "{{typo}}")).toEqual([]);
  });

  it("links every plugin settings page that holds automation parameters, once each", () => {
    const ids = AUTOMATION_LINKS.map((l) => l.pluginId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ["vibe-master", "vibe-board", "vibe-verify", "vibe-context", "switch-provider", "vibe-maintain", "vibe-scheduler"]) {
      expect(ids).toContain(id);
    }
    expect(AUTOMATION_LINKS.every((l) => l.label.length > 0 && l.screenId === "preferences")).toBe(true);
  });
});
