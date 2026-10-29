import { describe, expect, it } from "vitest";
import { buildProjectDocumentBackRoute, buildProjectDocumentRoute } from "./document-navigation";
import { buildProjectSettingsRoute } from "@/utils/host-routes";

describe("project document navigation", () => {
  it("returns from a reader to the document list and from the list or brief to project settings", () => {
    expect(buildProjectDocumentBackRoute("host", "project", "docs/a.md")).toEqual(
      buildProjectDocumentRoute("host", "project", "documents"),
    );
    expect(buildProjectDocumentBackRoute("host", "project")).toEqual(
      buildProjectSettingsRoute("host", "project"),
    );
  });
});
