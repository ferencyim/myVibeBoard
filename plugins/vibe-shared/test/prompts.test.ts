import { describe, expect, it } from "vitest";
import {
  composePrompt,
  parsePromptOverrideId,
  promptOverrideId,
  renderPromptTemplate,
  unknownPromptPlaceholders,
} from "../contract/prompts";
import { CommandError } from "../db";
import { setup } from "./helpers";

const def = (over: Record<string, unknown> = {}) => ({
  key: "demo.hello",
  plugin: "demo",
  role: "master" as const,
  title: "Hello",
  defaultText: "Hi {{name}}",
  placeholders: [{ name: "name", description: "who" }],
  fixedSuffix: "Reply with JSON.",
  ...over,
});

function seed() {
  const s = setup();
  s.store.prompts.register([
    def(),
    def({ key: "demo.other", title: "Other", defaultText: "x", fixedSuffix: "", order: 2 }),
  ]);
  const p = s.store.projects.create({ name: "Demo", prefix: "DEMO", repoPath: "<repo>" });
  return { ...s, projectId: p.id };
}

describe("rendering", () => {
  it("replaces each placeholder once and never scans substituted values", () => {
    const out = renderPromptTemplate("A {{x}} B {{ y }} C {{missing}}", { x: "{{y}}", y: "Y" });
    expect(out).toBe("A {{y}} B Y C ");
  });
  it("appends the fixed suffix after a blank line, or returns the body alone", () => {
    expect(composePrompt("body", "tail")).toBe("body\n\ntail");
    expect(composePrompt("body", "")).toBe("body");
    expect(composePrompt("", "tail")).toBe("tail");
  });
  it("lists placeholders the prompt does not declare", () => {
    expect(unknownPromptPlaceholders("{{a}} {{b.c}} {{a}}", [{ name: "a" }])).toEqual(["b.c"]);
  });
  it("round-trips override ids", () => {
    expect(parsePromptOverrideId(promptOverrideId("a.b", null))).toEqual({
      key: "a.b",
      projectId: null,
    });
    expect(parsePromptOverrideId(promptOverrideId("a.b", "P1"))).toEqual({
      key: "a.b",
      projectId: "P1",
    });
    expect(parsePromptOverrideId("nonsense")).toBeNull();
  });
});

describe("prompt registry", () => {
  it("resolves default text with vars and the fixed suffix", () => {
    const { store } = seed();
    expect(store.prompts.resolve("demo.hello", { vars: { name: "Ann" } })).toBe(
      "Hi Ann\n\nReply with JSON.",
    );
    expect(store.prompts.resolve("demo.other")).toBe("x");
  });

  it("a prompt without placeholders is used verbatim", () => {
    const { store } = seed();
    store.prompts.register([
      def({ key: "demo.raw", placeholders: [], defaultText: "keep {{this}}", fixedSuffix: "" }),
    ]);
    expect(store.prompts.resolve("demo.raw", { vars: { this: "gone" } })).toBe("keep {{this}}");
  });

  it("a customised body keeps the fixed suffix", () => {
    const { store } = seed();
    store.prompts.setOverride("demo.hello", "Yo {{name}}");
    expect(store.prompts.resolve("demo.hello", { vars: { name: "Ann" } })).toBe(
      "Yo Ann\n\nReply with JSON.",
    );
  });

  it("re-registering updates defaults and metadata but never touches overrides", () => {
    const { store, projectId } = seed();
    store.prompts.setOverride("demo.hello", "G {{name}}");
    store.prompts.setOverride("demo.hello", "P {{name}}", { projectId });
    store.prompts.register([def({ defaultText: "New default", title: "Renamed" })]);
    const info = store.prompts.list({ projectId }).find((p) => p.key === "demo.hello")!;
    expect(info.title).toBe("Renamed");
    expect(info.defaultText).toBe("New default");
    expect(info.globalOverride).toBe("G {{name}}");
    expect(info.projectOverride).toBe("P {{name}}");
  });

  it("scope priority: project > global > default", () => {
    const { store, projectId } = seed();
    const vars = { name: "n" };
    expect(store.prompts.body("demo.hello", { projectId }).source).toBe("default");
    store.prompts.setOverride("demo.hello", "global {{name}}");
    expect(store.prompts.resolve("demo.hello", { vars, projectId })).toContain("global n");
    store.prompts.setOverride("demo.hello", "project {{name}}", { projectId });
    expect(store.prompts.resolve("demo.hello", { vars, projectId })).toContain("project n");
    expect(store.prompts.resolve("demo.hello", { vars })).toContain("global n");
    expect(store.prompts.resolve("demo.hello", { vars, projectId: "other-project" })).toContain(
      "global n",
    );
    store.prompts.clearOverride("demo.hello", { projectId });
    expect(store.prompts.body("demo.hello", { projectId }).source).toBe("global");
    store.prompts.clearOverride("demo.hello");
    expect(store.prompts.body("demo.hello", { projectId }).source).toBe("default");
  });

  it("blank text clears; clearing an absent override is a no-op", () => {
    const { store } = seed();
    store.prompts.clearOverride("demo.hello");
    store.prompts.setOverride("demo.hello", "x");
    store.prompts.setOverride("demo.hello", "   \n");
    expect(store.prompts.body("demo.hello").source).toBe("default");
  });

  it("list reports source, effective text and overridden projects", () => {
    const { store, projectId } = seed();
    store.prompts.setOverride("demo.hello", "P", { projectId });
    expect(store.prompts.list().find((p) => p.key === "demo.hello")!.overriddenProjects).toEqual([
      projectId,
    ]);
    const listed = store.prompts.list({ projectId });
    expect(listed.map((p) => p.key)).toEqual(["demo.hello", "demo.other"]);
    expect(listed[0]).toMatchObject({ source: "project", effectiveText: "P" });
    expect(store.prompts.list()[0]).toMatchObject({
      source: "default",
      effectiveText: "Hi {{name}}",
    });
  });

  it("rejects unknown keys, unknown projects, unknown roles and oversize text", () => {
    const { store } = seed();
    expect(() => store.prompts.resolve("nope")).toThrow(CommandError);
    expect(() => store.prompts.setOverride("nope", "x")).toThrow(CommandError);
    expect(() => store.prompts.setOverride("demo.hello", "x", { projectId: "ghost" })).toThrow(
      CommandError,
    );
    expect(() => store.prompts.setOverride("demo.hello", "x".repeat(100_001))).toThrow(
      CommandError,
    );
    expect(() => store.prompts.register([def({ role: "boss" })])).toThrow();
  });

  it("moves overrides of merged keys, keeps conflicts as orphans and can discard them", () => {
    const { store, projectId } = seed();
    store.prompts.setOverride("demo.hello", "old global");
    store.prompts.setOverride("demo.hello", "old project", { projectId });
    store.prompts.register(
      [
        def({
          key: "demo.merged",
          defaultText: "Merged",
          placeholders: [],
          fixedSuffix: "",
        }),
      ],
      { pruneMissing: true, aliases: { "demo.hello": "demo.merged" } },
    );
    const merged = store.prompts.list({ projectId })[0]!;
    expect(merged).toMatchObject({
      key: "demo.merged",
      globalOverride: "old global",
      projectOverride: "old project",
    });
    expect(store.prompts.orphans()).toEqual([]);

    // A target that already has its own override keeps it; the old one is reported, not lost.
    store.prompts.register([def({ key: "demo.hello" })]);
    store.prompts.setOverride("demo.merged", "new global");
    store.prompts.setOverride("demo.hello", "stale global");
    store.prompts.register(
      [def({ key: "demo.merged", defaultText: "Merged", placeholders: [], fixedSuffix: "" })],
      { pruneMissing: true, aliases: { "demo.hello": "demo.merged" } },
    );
    expect(store.prompts.body("demo.merged").text).toBe("new global");
    expect(store.prompts.orphans()).toEqual([{ key: "demo.hello", projectId: null }]);

    store.prompts.clearOverride("demo.hello");
    expect(store.prompts.orphans()).toEqual([]);
  });

  it("pruneMissing drops this plugin's stale templates only", () => {
    const { store } = seed();
    store.prompts.register([def({ key: "other.one", plugin: "other" })]);
    store.prompts.register([def()], { pruneMissing: true });
    expect(
      store.prompts
        .list()
        .map((p) => p.key)
        .sort(),
    ).toEqual(["demo.hello", "other.one"]);
  });
});
