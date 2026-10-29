import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { ProjectDocumentsSection } from "./project-documents-section";
import { ProjectDocumentsRoute } from "./project-documents-route";
import { buildProjectDocumentRoute, projectDocumentEntries } from "./document-navigation";

const captured = vi.hoisted(() => ({
  push: vi.fn(),
  presses: new Map<string, () => void>(),
  page: null as Record<string, unknown> | null,
  state: {
    documents: [
      {
        path: "AGENTS.md",
        content: "# 简介摘要\n绝不可直接铺在设置里的长文正文",
        revision: "one",
        totalBytes: 100,
        truncated: false,
        syncedAt: "2026-10-29T00:00:00Z",
      },
    ],
    pending: [],
    outbox: [],
  },
}));
vi.mock("expo-router", () => ({
  useRouter: () => ({ push: captured.push }),
  useLocalSearchParams: () => ({
    serverId: ["host"],
    projectId: ["project/特殊"],
    path: ["docs/需求 #1.md"],
  }),
}));
vi.mock("./use-project-documents", () => ({
  useProjectDocuments: () => ({
    state: captured.state,
    connected: false,
    loaded: true,
    error: null,
  }),
}));
vi.mock("@/components/settings/headings/settings-section", () => ({
  SettingsSection: ({ children }: React.PropsWithChildren) => <section>{children}</section>,
}));
vi.mock("@/components/ui/navigation-row", () => ({
  NavigationRow: ({
    title,
    description,
    status,
    testID,
    onPress,
  }: {
    title: string;
    description: string;
    status?: string;
    testID: string;
    onPress(): void;
  }) => {
    captured.presses.set(testID, onPress);
    return (
      <div>
        {title}|{description}|{status}
      </div>
    );
  },
}));
vi.mock("@/components/host-route-bootstrap-boundary", () => ({
  HostRouteBootstrapBoundary: ({ children }: React.PropsWithChildren) => children,
}));
vi.mock("./project-documents-page", () => ({
  ProjectDocumentsPage: (props: Record<string, unknown>) => {
    captured.page = props;
    return null;
  },
}));

beforeEach(() => {
  vi.stubGlobal("React", React);
  captured.push.mockClear();
  captured.presses.clear();
});

it("renders only summary, sync status and count in settings, and opens project-scoped child routes", () => {
  const markup = renderToStaticMarkup(
    <ProjectDocumentsSection serverId="host" projectId="project/特殊" />,
  );
  expect(markup).toContain("简介摘要");
  expect(markup).toContain("离线缓存");
  expect(markup).toContain("1 份文档");
  expect(markup).not.toContain("长文正文");
  captured.presses.get("project-brief-entry")!();
  captured.presses.get("project-documents-entry")!();
  expect(captured.push.mock.calls.map(([route]) => route)).toEqual([
    buildProjectDocumentRoute("host", "project/特殊", "brief"),
    buildProjectDocumentRoute("host", "project/特殊", "documents"),
  ]);
});

it("preserves matched host, project and document params at the child route boundary", () => {
  renderToStaticMarkup(<ProjectDocumentsRoute page="documents" />);
  expect(captured.page).toEqual({
    serverId: "host",
    projectId: "project/特殊",
    path: "docs/需求 #1.md",
    page: "documents",
  });
  const list = buildProjectDocumentRoute("host", "project/特殊", "documents");
  const reader = buildProjectDocumentRoute("host", "project/特殊", "documents", "docs/需求 #1.md");
  expect(reader.pathname).not.toBe(list.pathname);
  expect(reader.params).toEqual({
    serverId: "host",
    projectId: "project/特殊",
    path: "docs/需求 #1.md",
  });
});

it("bounds long single-line summaries and surfaces offline pending edits", () => {
  const entries = projectDocumentEntries(
    {
      ...captured.state,
      outbox: [
        {
          id: "local",
          createdAt: "now",
          documents: [{ path: "AGENTS.md", content: "新".repeat(500), baseRevision: "one" }],
        },
      ],
    },
    false,
  );
  expect(entries.summary).toHaveLength(120);
  expect(entries.syncStatus).toBe("待合并 1 项");
});
