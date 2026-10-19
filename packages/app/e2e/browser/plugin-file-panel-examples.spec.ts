import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TestInfo } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { copyPluginExample } from "../support/helpers/plugin-fixture";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { seedWorkspace } from "../support/helpers/seed-client";
import { gotoWorkspace } from "../support/helpers/launcher";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import {
  openFileExplorer,
  openFileFromExplorer,
  expectFileTabOpen,
} from "../support/helpers/file-explorer";

// Full Chromium includes the PDF viewer; the default headless shell does not.
test.use({ channel: "chromium" });

function samplePdf() {
  const stream = "BT /F1 24 Tf 72 720 Td (Paseo PDF panel example) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n%\u0000\u00ff\n";
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(pdf);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}

async function openFile(page: Page, name: string) {
  await openFileFromExplorer(page, name);
  await expectFileTabOpen(page, name);
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const file = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: file });
  await testInfo.attach(name, { path: file, contentType: "image/png" });
}

async function chooseRichMarkdown(page: Page) {
  await page.getByRole("radio", { name: "Rich Markdown — markdown-panel", exact: true }).click();
  await page.getByRole("checkbox", { name: "Don't ask me again", exact: true }).click();
  await page.getByRole("button", { name: "Use", exact: true }).click();
}

async function replaceMarkdown(page: Page, text: string) {
  await page.getByRole("textbox", { name: "Rich Markdown editor", exact: true }).fill(text);
}

async function selectSource(page: Page) {
  await page
    .getByTestId("file-panel-bar")
    .getByRole("button", { name: "Source", exact: true })
    .click();
}

async function selectPreview(page: Page) {
  await page
    .getByTestId("file-panel-bar")
    .getByRole("button", { name: "Preview", exact: true })
    .click();
}

async function expectPdfViewerReady(page: Page) {
  const viewerUrl = /^chrome-extension:\/\/[^/]+\/index\.html$/;
  await expect.poll(() => page.frame({ url: viewerUrl }) !== null).toBe(true);
  const viewer = page.frame({ url: viewerUrl })!;
  await expect(viewer.getByRole("textbox", { name: "Page number", exact: true })).toHaveValue("1");
  await expect(viewer.getByRole("button", { name: "Print", exact: true })).toBeEnabled();
}

async function expectCompactMarkdownEditor(page: Page, text: string) {
  const editor = page.getByRole("textbox", { name: "Rich Markdown editor", exact: true });
  await expect(editor).toBeVisible();
  await expect(editor).toContainText(text);
  await expect(editor).toBeInViewport({ ratio: 1 });
  const bar = page.getByTestId("file-panel-bar").filter({ visible: true });
  await expect(bar.getByRole("button", { name: "Preview", exact: true })).toBeInViewport({
    ratio: 1,
  });
  await expect(bar.getByRole("button", { name: "Source", exact: true })).toBeInViewport({
    ratio: 1,
  });
}

test("directory examples mount the PDF frame and edit Markdown through Paseo's document", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const pdf = await copyPluginExample("pdf-panel");
  const markdown = await copyPluginExample("markdown-panel");
  execFileSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: markdown.directory, stdio: "pipe" },
  );
  const workspace = await seedWorkspace({
    repoPrefix: "file-panel-examples-",
    repo: {
      files: [
        {
          path: "notes.md",
          content: "# Markdown panel example\n\nEdit **Markdown** through Paseo.\n",
        },
        { path: "second.md", content: "# Remembered panel\n" },
        { path: "report.pdf", content: samplePdf() },
      ],
    },
  });
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previous = await client.getDaemonConfig();
  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(pdf.directory);
    await client.installDirectoryPlugin(markdown.directory);
    await page.setViewportSize({ width: 1280, height: 900 });
    const gate = await installDaemonWebSocketGate(page);
    await gotoWorkspace(page, workspace.workspaceId);
    await openFileExplorer(page);
    await openFile(page, "report.pdf");
    await expect(page.getByTitle("Document preview", { exact: true })).toHaveAttribute(
      "src",
      /^blob:/,
    );
    await expect(page.getByTitle("Document preview", { exact: true })).not.toHaveAttribute(
      "sandbox",
    );
    const documentUrl = await page
      .getByTitle("Document preview", { exact: true })
      .getAttribute("src");
    expect(
      await page.evaluate(
        async (url) => (await fetch(url!)).blob().then((blob) => blob.type),
        documentUrl,
      ),
    ).toBe("application/pdf");
    await expectPdfViewerReady(page);
    await capture(page, testInfo, "pdf-example-web");

    await openFile(page, "notes.md");
    await expect(page.getByRole("radio", { name: "Markdown — Paseo", exact: true })).toBeChecked();
    await expect(
      page.getByRole("radio", { name: "Rich Markdown — markdown-panel", exact: true }),
    ).toBeVisible();
    await capture(page, testInfo, "markdown-example-picker-web");
    await chooseRichMarkdown(page);
    await expect(page.getByRole("textbox", { name: "Rich Markdown editor" })).toContainText(
      "Markdown panel example",
    );
    gate.holdNextClientRequest("fs.file.write.request");
    await replaceMarkdown(page, "# Edited by Rich Markdown\n\nAutosaved by Paseo.\n");
    await gate.waitForHeldClientRequest();
    await expect(page.getByTestId("workspace-tab-modified-file_notes.md")).toBeVisible();
    await capture(page, testInfo, "markdown-example-dirty-web");
    gate.releaseHeldClientRequest();
    await expect
      .poll(() => readFile(path.join(workspace.repoPath, "notes.md"), "utf8"))
      .toBe("# Edited by Rich Markdown\n\nAutosaved by Paseo.\n");
    await expect(page.getByTestId("workspace-tab-modified-file_notes.md")).toBeHidden();
    await capture(page, testInfo, "markdown-example-editor-web");

    await selectSource(page);
    await expect(
      page.getByTestId("file-source-editor").filter({ visible: true }).locator(".cm-content"),
    ).toContainText("Edited by Rich Markdown");
    await capture(page, testInfo, "markdown-example-source-web");
    await selectPreview(page);
    await writeFile(path.join(workspace.repoPath, "notes.md"), "# External update\n");
    await expect(page.getByRole("textbox", { name: "Rich Markdown editor" })).toHaveText(
      "# External update",
    );
    await replaceMarkdown(page, "# Local edit\n");
    await writeFile(path.join(workspace.repoPath, "notes.md"), "# Conflicting external edit\n");
    await expect(page.getByTestId("file-conflict-alert")).toBeVisible();
    await capture(page, testInfo, "markdown-example-conflict-web");
    await page.getByRole("button", { name: "Overwrite", exact: true }).click();
    await expect
      .poll(() => readFile(path.join(workspace.repoPath, "notes.md"), "utf8"))
      .toBe("# Local edit\n");

    await openFile(page, "second.md");
    await expect(page.getByRole("textbox", { name: "Rich Markdown editor" })).toContainText(
      "Remembered panel",
    );
    await expect(page.getByText("Open .md files with", { exact: true })).toBeHidden();
    await page.setViewportSize({ width: 390, height: 844 });
    await expectCompactMarkdownEditor(page, "Remembered panel");
    await capture(page, testInfo, "markdown-example-compact-web");
  } finally {
    await client.removePlugin("pdf-panel");
    await client.removePlugin("markdown-panel");
    await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled ?? false });
    await client.close();
    await workspace.cleanup();
    await pdf.cleanup();
    await markdown.cleanup();
  }
});
