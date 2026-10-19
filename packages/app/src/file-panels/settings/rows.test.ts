import { describe, expect, it } from "vitest";
import { builtinFilePanels } from "../catalog";
import type { FilePanelCandidate } from "../resolve";
import { buildFilePanelSettingsRows } from "./rows";

type HostedCandidate = FilePanelCandidate & { serverId?: string };

const builtins: HostedCandidate[] = [...builtinFilePanels];
const builtinMarkdown = builtins[0];

function richMarkdown(serverId: string): HostedCandidate {
  return {
    id: "plugin:markdown-panel/rich-markdown",
    files: { extensions: ["MD"] },
    document: "text",
    maxBytes: 10 * 1024 * 1024,
    serverId,
  };
}

const dockerfile: HostedCandidate = {
  id: "plugin:docker/dockerfile",
  files: { extensions: [], filenames: ["Dockerfile"] },
  document: "text",
  maxBytes: Infinity,
  serverId: "host-a",
};

function rows(candidates: HostedCandidate[], associations: Record<string, string> = {}) {
  return buildFilePanelSettingsRows({ candidates, associations });
}

describe("buildFilePanelSettingsRows", () => {
  it("has nothing to configure with only the built-in panels", () => {
    expect(rows(builtins)).toEqual([]);
  });

  it("lists a key two panels claim, built-in first, asking until something is remembered", () => {
    const plugin = richMarkdown("host-a");
    expect(rows([...builtins, plugin])).toEqual([
      { selectorKey: "ext:md", candidates: [builtinMarkdown, plugin], associatedPanelId: null },
    ]);
  });

  it("offers a panel installed on several hosts once, as the first host has it", () => {
    const first = richMarkdown("host-a");
    const [row] = rows([...builtins, first, richMarkdown("host-b")]);
    expect(row?.candidates).toEqual([builtinMarkdown, first]);
  });

  it("keeps a remembered key that only one known panel claims", () => {
    expect(rows(builtins, { "ext:markdown": "builtin:markdown" })).toEqual([
      {
        selectorKey: "ext:markdown",
        candidates: [builtinMarkdown],
        associatedPanelId: "builtin:markdown",
      },
    ]);
  });

  it("keeps a remembered key whose panel is on no connected host", () => {
    expect(rows(builtins, { "ext:pdf": "plugin:pdf-panel/pdf" })).toEqual([
      { selectorKey: "ext:pdf", candidates: [], associatedPanelId: "plugin:pdf-panel/pdf" },
    ]);
  });

  it("offers extension panels on a filename key the way the resolver does", () => {
    const named: HostedCandidate = {
      ...dockerfile,
      id: "plugin:readme/readme",
      files: { extensions: [], filenames: ["README.md"] },
    };
    const keys = rows([...builtins, named]).map((row) => row.selectorKey);
    expect(keys).toEqual(["name:README.md"]);
    expect(rows([...builtins, named])[0]?.candidates).toEqual([builtinMarkdown, named]);
  });

  it("orders extensions before filenames, each alphabetically", () => {
    const other: HostedCandidate = { ...dockerfile, id: "plugin:other/dockerfile" };
    const html: HostedCandidate = {
      ...richMarkdown("host-a"),
      id: "plugin:web/html",
      files: { extensions: ["html"] },
    };
    const keys = rows([...builtins, dockerfile, other, html, richMarkdown("host-a")]).map(
      (row) => row.selectorKey,
    );
    expect(keys).toEqual(["ext:html", "ext:md", "name:Dockerfile"]);
  });
});
