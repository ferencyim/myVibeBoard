import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestInfo } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { pluginRequirements } from "../support/helpers/plugin-fixture";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { seedWorkspace } from "../support/helpers/seed-client";
import { gotoWorkspace } from "../support/helpers/launcher";
import {
  expectFileTabOpen,
  openFileExplorer,
  openFileFromExplorer,
} from "../support/helpers/file-explorer";

const PLUGIN_ID = "file-panel-picker-e2e";
const PLUGIN_PANEL = `plugin:${PLUGIN_ID}/rich-markdown`;
const BUILTIN_OPTION = "Markdown — Paseo";
const PLUGIN_OPTION = `Rich Markdown — ${PLUGIN_ID}`;
const SOURCE = `import React from "react";
import { Text, View } from "react-native";
function RichMarkdown({ file }) {
  return <View><Text>Rich Markdown plugin: {file.name}</Text></View>;
}
export default function contribute(client) {
  client.addFilePanel({ id: "rich-markdown", title: "Rich Markdown", icon: "FileType",
    files: { extensions: ["md"] }, document: "text", Component: RichMarkdown });
  return () => {};
}`;

const picker = (page: Page) => page.getByText("Open .md files with", { exact: true });

async function openMarkdown(page: Page, name: string) {
  await openFileFromExplorer(page, name);
  await expectFileTabOpen(page, name);
}

async function expectBuiltinMarkdown(page: Page, heading: string) {
  await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
}

async function expectPluginMarkdown(page: Page, name: string) {
  await expect(page.getByText(`Rich Markdown plugin: ${name}`, { exact: true })).toBeVisible();
}

async function choosePanel(page: Page, option: string, options: { remember: boolean }) {
  await page.getByRole("radio", { name: option, exact: true }).click();
  if (options.remember) {
    await page.getByRole("checkbox", { name: "Don't ask me again", exact: true }).click();
  }
  await page.getByRole("button", { name: "Use", exact: true }).click();
  await expect(picker(page)).toBeHidden();
}

async function storedAssociations(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem("@paseo:app-settings") ?? "{}");
    return settings.filePanelAssociations ?? {};
  });
}

async function openWithFromTabMenu(page: Page, name: string, option: string) {
  await page.getByTestId(`workspace-tab-file_${name}`).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open with…" }).hover();
  await page.getByRole("menuitem", { name: option }).click();
}

async function toggleAlwaysUseFromFileBar(page: Page) {
  await page.getByTestId("file-panel-bar-menu").filter({ visible: true }).click();
  await page.getByRole("menuitem", { name: "Open with…" }).click();
  await page.getByRole("menuitem", { name: "Always use for .md" }).click();
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const file = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: file });
  await testInfo.attach(name, { path: file, contentType: "image/png" });
}

test("asks once which panel opens Markdown and remembers it when told to", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-file-panel-picker-"));
  const workspace = await seedWorkspace({
    repoPrefix: "file-panel-picker-",
    repo: {
      files: ["first", "second", "third", "fourth"].map((name) => ({
        path: `${name}.md`,
        content: `# ${name} heading\n`,
      })),
    },
  });
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previousConfig = await client.getDaemonConfig();
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({ id: PLUGIN_ID, requirements: pluginRequirements }),
  );
  await writeFile(path.join(directory, "index.client.tsx"), SOURCE);
  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoWorkspace(page, workspace.workspaceId);
    await openFileExplorer(page);

    // First open: the built-in renders under the picker.
    await openMarkdown(page, "first.md");
    await expect(picker(page)).toBeVisible();
    await expect(page.getByRole("radio", { name: BUILTIN_OPTION })).toBeChecked();
    await expect(page.getByRole("radio", { name: PLUGIN_OPTION })).not.toBeChecked();
    await expectBuiltinMarkdown(page, "first heading");
    await capture(page, testInfo, "file-panel-picker-wide");

    // Don't ask me again: the plugin renders and later opens use it silently.
    await choosePanel(page, PLUGIN_OPTION, { remember: true });
    await expectPluginMarkdown(page, "first.md");
    expect(await storedAssociations(page)).toEqual({ "ext:md": PLUGIN_PANEL });
    await openMarkdown(page, "second.md");
    await expectPluginMarkdown(page, "second.md");
    await expect(picker(page)).toBeHidden();

    // Forgetting from the file bar keeps the tab on the plugin.
    await toggleAlwaysUseFromFileBar(page);
    await expect.poll(() => storedAssociations(page)).toEqual({});
    await expectPluginMarkdown(page, "second.md");

    // An unremembered choice applies to this tab only; the next open asks again.
    await openMarkdown(page, "third.md");
    await expect(picker(page)).toBeVisible();
    await choosePanel(page, PLUGIN_OPTION, { remember: false });
    await expectPluginMarkdown(page, "third.md");
    expect(await storedAssociations(page)).toEqual({});

    // "Open with…" switches the open tab back to the built-in in place.
    await openWithFromTabMenu(page, "third.md", BUILTIN_OPTION);
    await expectBuiltinMarkdown(page, "third heading");
    await expectFileTabOpen(page, "third.md");

    // Dismissing keeps the built-in; reopening the tab after a reload asks again.
    await openMarkdown(page, "fourth.md");
    await expect(picker(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(picker(page)).toBeHidden();
    await expectBuiltinMarkdown(page, "fourth heading");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(picker(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Use", exact: true })).toBeInViewport({
      ratio: 1,
    });
    await capture(page, testInfo, "file-panel-picker-compact");
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
