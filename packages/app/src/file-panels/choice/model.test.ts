import { describe, expect, it } from "vitest";
import { resolveFilePanel, type FilePanelCandidate } from "../resolve";
import { chosenPanelFor, FilePanelChoiceModel } from "./model";

const markdown: FilePanelCandidate = {
  id: "builtin:markdown",
  files: { extensions: ["md", "markdown"] },
  document: "text",
  maxBytes: Infinity,
};
const rich: FilePanelCandidate = { ...markdown, id: "plugin:notes/rich" };

/** A file tab: resolves against the shared associations and feeds the result to its model. */
function openTab(
  associations: Record<string, string>,
  candidates = [markdown, rich],
  options: { presentable?: boolean } = {},
) {
  const model = new FilePanelChoiceModel<FilePanelCandidate>({
    remember(selectorKey, panelId) {
      if (panelId === null) delete associations[selectorKey];
      else associations[selectorKey] = panelId;
    },
  });
  let targetKey = "/repo:notes.md";
  let presentable = options.presentable ?? true;
  const resolve = () =>
    resolveFilePanel({
      file: { path: targetKey.split(":")[1]!, kind: "text", size: 10, hasBytes: true },
      candidates,
      associations,
      choice: chosenPanelFor(model.getSnapshot(), targetKey),
    });
  const render = () => {
    const resolution = resolve();
    model.observe({ targetKey, resolution, presentable });
    return resolution.panel?.id ?? null;
  };
  render();
  return {
    model,
    render,
    panel: () => render(),
    picker: () => model.getSnapshot().picker,
    retarget(path: string) {
      targetKey = `/repo:${path}`;
      return render();
    },
    setPresentable(next: boolean) {
      presentable = next;
      return render();
    },
  };
}

describe("FilePanelChoiceModel", () => {
  it("asks once per tab open over the first candidate, and dismissing keeps it", () => {
    const associations = {};
    const tab = openTab(associations);
    expect(tab.panel()).toBe(markdown.id);
    expect(tab.picker()).toMatchObject({
      selectorKey: "ext:md",
      selectedPanelId: markdown.id,
      remember: false,
    });
    tab.model.dismissPicker();
    expect(tab.picker()).toBeNull();
    expect(tab.panel()).toBe(markdown.id);
    expect(tab.picker()).toBeNull();
    expect(associations).toEqual({});

    expect(openTab(associations).picker()).not.toBeNull();
  });

  it("remembers the choice when Don't ask me again is checked", () => {
    const associations: Record<string, string> = {};
    const tab = openTab(associations);
    tab.model.selectInPicker(rich.id);
    tab.model.setRemember(true);
    tab.model.confirmPicker();
    expect(tab.panel()).toBe(rich.id);
    expect(associations).toEqual({ "ext:md": rich.id });

    const next = openTab(associations);
    expect(next.panel()).toBe(rich.id);
    expect(next.picker()).toBeNull();
  });

  it("uses an unremembered choice for this tab only and asks again on the next open", () => {
    const associations = {};
    const tab = openTab(associations);
    tab.model.selectInPicker(rich.id);
    tab.model.confirmPicker();
    expect(tab.panel()).toBe(rich.id);
    expect(associations).toEqual({});

    const next = openTab(associations);
    expect(next.panel()).toBe(markdown.id);
    expect(next.picker()).not.toBeNull();
  });

  it("does not ask with one candidate, an association, or while the preview is off screen", () => {
    expect(openTab({}, [markdown]).picker()).toBeNull();
    expect(openTab({}, [markdown]).model.getSnapshot().openWith).toBeNull();
    expect(openTab({ "ext:md": rich.id }).picker()).toBeNull();

    const background = openTab({}, [markdown, rich], { presentable: false });
    expect(background.picker()).toBeNull();
    background.setPresentable(true);
    expect(background.picker()).not.toBeNull();
  });

  it("starts a new open when the tab is retargeted", () => {
    const tab = openTab({});
    tab.model.selectInPicker(rich.id);
    tab.model.confirmPicker();
    expect(tab.retarget("other.md")).toBe(markdown.id);
    expect(tab.picker()).not.toBeNull();
  });

  it("switches with Open with and toggles Always use without moving the tab", () => {
    const associations: Record<string, string> = {};
    const tab = openTab(associations);
    tab.model.dismissPicker();
    expect(tab.model.getSnapshot().openWith).toMatchObject({
      activePanelId: markdown.id,
      remembered: false,
      candidates: [markdown, rich],
    });

    tab.model.openWith(rich.id);
    expect(tab.panel()).toBe(rich.id);
    tab.model.toggleAlwaysUse();
    expect(associations).toEqual({ "ext:md": rich.id });
    tab.render();
    expect(tab.model.getSnapshot().openWith?.remembered).toBe(true);

    tab.model.openWith(markdown.id);
    expect(tab.panel()).toBe(markdown.id);
    expect(tab.model.getSnapshot().openWith?.remembered).toBe(false);
    tab.model.openWith(rich.id);
    tab.render();
    tab.model.toggleAlwaysUse();
    expect(associations).toEqual({});
    expect(tab.panel()).toBe(rich.id);
  });

  it("asks when a second candidate arrives after the file first rendered", () => {
    const candidates = [markdown];
    const tab = openTab({}, candidates);
    expect(tab.picker()).toBeNull();
    candidates.push(rich);
    tab.render();
    expect(tab.picker()).not.toBeNull();
  });
});
