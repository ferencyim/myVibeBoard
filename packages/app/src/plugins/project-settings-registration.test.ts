import { describe, expect, it, vi } from "vitest";
import { runPluginClientBundle, type PluginClientRuntime } from "./evaluate";

// Registration tests do not mount app surfaces or load their native dependencies.
vi.mock("./react-native/ui", () => ({}));
vi.mock("./themes", () => ({ parsePluginThemeContribution: () => null }));
vi.mock("./icons", () => ({
  parsePluginIcon: () => null,
  parseSerializablePluginIcon: () => null,
}));
vi.mock("./settings/use-settings", () => ({ useSettings: () => {} }));
vi.mock("@/utils/open-external-url", () => ({ openExternalUrl: () => {} }));

const runtime = {} as PluginClientRuntime;
function bundle(body: string) {
  return `(function(require) { return { default(plugin) { ${body}; return () => {}; } }; })`;
}
function evaluatePluginClientBundle(id: string, source: string) {
  return runPluginClientBundle(id, source, runtime);
}

describe("project settings registration", () => {
  it("registers a default first-message resolver and removes it on cleanup", async () => {
    const plugin = evaluatePluginClientBundle(
      "models",
      bundle(`
      const remove = plugin.addFirstMessageModelResolver({ resolve: async () => ({ provider: "codex", model: "selected" }) });
      remove();
      plugin.addFirstMessageModelResolver({ resolve: async ({projectId}) => ({ provider: "codex", model: projectId }) });
    `),
    );
    expect(await plugin.firstMessageModelResolvers[0]?.resolve({ projectId: "project" })).toEqual({
      provider: "codex",
      model: "project",
    });
    await plugin.cleanup();
    expect(plugin.firstMessageModelResolvers).toEqual([]);
  });

  it("rejects invalid and duplicate default first-message resolvers", () => {
    expect(() =>
      evaluatePluginClientBundle(
        "invalid",
        bundle("plugin.addFirstMessageModelResolver({ resolve: null });"),
      ),
    ).toThrow("Invalid first message model resolver");
    expect(() =>
      evaluatePluginClientBundle(
        "duplicate",
        bundle(
          "for(let i = 0; i < 2; i++) plugin.addFirstMessageModelResolver({ resolve: async () => null });",
        ),
      ),
    ).toThrow("Duplicate first message model resolver");
  });
  it("registers project settings sections and releases their ids", async () => {
    const plugin = evaluatePluginClientBundle(
      "settings",
      bundle(`
      const Component = require("react").memo(function Settings() { return null; });
      const remove = plugin.addProjectSettingsSection({ id: "defaults", title: "Defaults", order: 3, Component });
      remove();
      plugin.addProjectSettingsSection({ id: "defaults", title: "Defaults", order: 1, Component });
    `),
    );
    expect(plugin.projectSettingsSections.map(({ id, order }) => ({ id, order }))).toEqual([
      { id: "defaults", order: 1 },
    ]);
    await plugin.cleanup();
    expect(plugin.projectSettingsSections).toEqual([]);
  });

  it.each([
    ['id: "", title: "Title", Component() {}', "Invalid project settings section id"],
    ['id: "defaults", title: "", Component() {}', "has no title"],
    ['id: "defaults", title: "Title", Component: null', "is not a component"],
    ['id: "defaults", title: "Title", Component() {}, order: NaN', "has invalid order"],
  ])("rejects invalid project section %s", (fields, message) => {
    expect(() =>
      evaluatePluginClientBundle(
        "invalid",
        bundle(`plugin.addProjectSettingsSection({ ${fields} });`),
      ),
    ).toThrow(message);
  });

  it("rejects duplicate project settings sections", () => {
    expect(() =>
      evaluatePluginClientBundle(
        "duplicate",
        bundle(`
      for (let i = 0; i < 2; i++) plugin.addProjectSettingsSection({ id: "defaults", title: "Defaults", Component() {} });
    `),
      ),
    ).toThrow("Duplicate project settings section");
  });
});
