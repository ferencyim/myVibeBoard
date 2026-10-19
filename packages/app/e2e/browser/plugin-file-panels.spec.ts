import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import { pluginRequirements } from "../support/helpers/plugin-fixture";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { seedWorkspace } from "../support/helpers/seed-client";
import { gotoWorkspace } from "../support/helpers/launcher";
import {
  openFileExplorer,
  openFileFromExplorer,
  expectFileTabOpen,
} from "../support/helpers/file-explorer";

const PLUGIN_ID = "file-panel-e2e";
const PDF = Buffer.from("%PDF-1.4\n%\x00\xff\n1 0 obj<</Type/Catalog>>endobj\n%%EOF", "binary");
const SOURCE = `import React, { useEffect, useState } from "react";
import { Text, View, Pressable } from "react-native";
import { usePaseo, useWorkspace } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import { DocumentFrame } from "@getpaseo/plugin/client/ui";
function Pdf({ document, file, workspaceId }) {
  usePaseo();
  useQueryClient();
  const workspace = useWorkspace(workspaceId, value => ({ id: value.id }));
  const [urlBytes, setUrlBytes] = useState(-1);
  useEffect(() => {
    fetch(document.url).then(response => response.arrayBuffer()).then(bytes => setUrlBytes(bytes.byteLength));
  }, [document.url]);
  return <View style={{ flex: 1 }}>
    <Text>PDF plugin: {file.name}</Text>
    <Text>Path {file.path}</Text>
    <Text>Bytes {document.bytes.length}; URL bytes {urlBytes}</Text>
    <Text>Workspace {workspace?.id}</Text>
    <DocumentFrame url={document.url} testID="plugin-pdf-frame" />
  </View>;
}
function Markdown({ document }) {
  return <View>
    <Text>Plugin Markdown: {document.text}</Text>
    <Text>{document.editable ? "Plugin document editable" : "Plugin document readonly"}</Text>
    <Pressable accessibilityRole="button" onPress={() => document.setText("# Saved by plugin\\n")}>
      <Text>Edit Markdown through plugin</Text>
    </Pressable>
  </View>;
}
export default function contribute(client) {
  client.addFilePanel({ id: "pdf", title: "PDF", icon: "FileText",
    files: { extensions: ["pdf", "txt"] }, document: "bytes", Component: Pdf });
  client.addFilePanel({ id: "markdown", title: "Plugin Markdown", icon: "FileText",
    files: { extensions: ["md"] }, document: "text", Component: Markdown });
  return () => {};
}`;

async function openWorkspaceFile(page: Page, name: string) {
  await openFileFromExplorer(page, name);
  await expectFileTabOpen(page, name);
}
async function associateMarkdownWithPlugin(page: Page) {
  await page.evaluate(() => {
    const key = "@paseo:app-settings";
    const settings = JSON.parse(localStorage.getItem(key) ?? "{}");
    settings.filePanelAssociations = { "ext:md": "plugin:file-panel-e2e/markdown" };
    localStorage.setItem(key, JSON.stringify(settings));
  });
  await page.reload();
}
async function editMarkdownThroughPlugin(page: Page) {
  await page.getByRole("button", { name: "Edit Markdown through plugin", exact: true }).click();
}
async function selectSource(page: Page) {
  await page
    .getByTestId("file-panel-bar")
    .getByRole("button", { name: "Source", exact: true })
    .click();
}

test("directory plugins render PDF bytes and edit associated Markdown through the host document", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-file-panels-plugin-"));
  const workspace = await seedWorkspace({
    repoPrefix: "file-panels-",
    repo: {
      files: [
        { path: "notes.md", content: "# Built-in Markdown\n" },
        { path: "bytes.txt", content: "Bytes panel text document" },
      ],
    },
  });
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previousConfig = await client.getDaemonConfig();
  await writeFile(path.join(workspace.repoPath, "report.pdf"), PDF);
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({ id: PLUGIN_ID, requirements: pluginRequirements }),
  );
  await writeFile(path.join(directory, "index.client.tsx"), SOURCE);
  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    await page.setViewportSize({ width: 1280, height: 900 });
    const gate = await installDaemonWebSocketGate(page);
    await gotoWorkspace(page, workspace.workspaceId);
    await openFileExplorer(page);
    await openWorkspaceFile(page, "report.pdf");
    await expect(page.getByText("PDF plugin: report.pdf", { exact: true })).toBeVisible();
    await expect(
      page.getByText(`Bytes ${PDF.length}; URL bytes ${PDF.length}`, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(`Workspace ${workspace.workspaceId}`, { exact: true }),
    ).toBeVisible();
    await expect(page.getByTitle("Document preview", { exact: true })).toHaveAttribute(
      "src",
      /^blob:/,
    );
    await expect(
      page.getByText(`Path ${path.join(workspace.repoPath, "report.pdf")}`, { exact: true }),
    ).toBeVisible();
    const pdfScreenshot = testInfo.outputPath("plugin-pdf-web.png");
    await page.screenshot({ path: pdfScreenshot });
    await testInfo.attach("plugin-pdf-web", { path: pdfScreenshot, contentType: "image/png" });

    await openWorkspaceFile(page, "bytes.txt");
    await expect(page.getByText("PDF plugin: bytes.txt", { exact: true })).toBeVisible();
    await expect(page.getByTitle("Document preview", { exact: true })).toBeVisible();
    await expect(
      page
        .frameLocator('[title="Document preview"]')
        .getByText("Bytes panel text document", { exact: true }),
    ).toBeVisible();

    await openWorkspaceFile(page, "notes.md");
    await expect(
      page.getByRole("heading", { name: "Built-in Markdown", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit Markdown through plugin" })).toHaveCount(0);
    await associateMarkdownWithPlugin(page);
    await expect(page.getByText("Plugin document editable", { exact: true })).toBeVisible();
    gate.holdNextClientRequest("fs.file.write.request");
    await editMarkdownThroughPlugin(page);
    await gate.waitForHeldClientRequest();
    await expect(page.getByTestId("workspace-tab-modified-file_notes.md")).toBeVisible();
    gate.releaseHeldClientRequest();
    await expect(
      page.getByText("Plugin Markdown: # Saved by plugin", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(() => readFile(path.join(workspace.repoPath, "notes.md"), "utf8"))
      .toBe("# Saved by plugin\n");
    await selectSource(page);
    await expect(
      page.getByTestId("file-source-editor").filter({ visible: true }).locator(".cm-content"),
    ).toHaveText("# Saved by plugin");
    const markdownScreenshot = testInfo.outputPath("plugin-markdown-source-web.png");
    await page.screenshot({ path: markdownScreenshot });
    await testInfo.attach("plugin-markdown-source-web", {
      path: markdownScreenshot,
      contentType: "image/png",
    });
  } finally {
    await client.removePlugin(PLUGIN_ID);
    await client.patchDaemonConfig({
      pluginsEnabled: previousConfig.config.pluginsEnabled ?? false,
    });
    await client.close();
    await workspace.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
});
