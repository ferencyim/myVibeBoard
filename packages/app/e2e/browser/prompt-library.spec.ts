import { expect, test, type Page } from "../support/fixtures";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  composerLocator,
  expectComposerVisible,
  fillComposerDraft,
} from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { waitForSettledPosition } from "../support/helpers/sheet-layout";

// Screenshot output is opt-in so the spec stays portable; QA passes a directory when it wants
// wide and compact evidence attached to a work package.
const SHOTS_DIR = process.env.PASEO_E2E_SCREENSHOT_DIR;

async function capture(page: Page, name: string): Promise<void> {
  if (!SHOTS_DIR) return;
  mkdirSync(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`) });
}

async function createPrompt(
  page: Page,
  input: { title: string; body: string; tags: string[] },
): Promise<void> {
  const library = page.getByTestId("prompt-library-page");
  await page.getByTestId("prompt-library-manager-new").click();
  await page.getByTestId("prompt-library-manager-title").fill(input.title);
  await page.getByTestId("prompt-library-manager-body").fill(input.body);
  for (const tag of input.tags) {
    await page.getByTestId("prompt-library-manager-tag-input").fill(tag);
    await page.getByTestId("prompt-library-manager-add-tag").click();
    await expect(page.getByTestId(`prompt-library-manager-remove-tag-${tag}`)).toBeVisible();
  }
  await page.getByTestId("prompt-library-manager-save").click();
  await expect(library.getByText(input.title, { exact: true }).first()).toBeVisible();
}

async function openManager(page: Page): Promise<void> {
  await page.getByTestId("composer-prompt-library-button").click();
  await page.getByTestId("prompt-library-picker-manage").click();
  await expect(page.getByTestId("prompt-library-page")).toBeVisible();
}

async function closeManager(page: Page): Promise<void> {
  await page.goBack();
  await expectComposerVisible(page);
}

async function closeSheet(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
}

async function rowIdFor(page: Page, title: string): Promise<string> {
  const row = page
    .locator('[data-testid^="prompt-library-manager-row-"]')
    .filter({ hasText: title })
    .first();
  const testId = await row.getAttribute("data-testid");
  return (testId ?? "").replace("prompt-library-manager-row-", "");
}

function daemonLibraryFile(): string {
  const home = process.env.E2E_PASEO_HOME;
  if (!home) throw new Error("E2E_PASEO_HOME is not set");
  return path.join(home, "prompt-library.json");
}

function daemonLibraryText(): string {
  try {
    return readFileSync(daemonLibraryFile(), "utf8");
  } catch {
    return "";
  }
}

test.describe.configure({ retries: 0 });

test("prompt library: create, insert at cursor, filter, rename tags, and sync offline edits", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const workspace = await seedMockAgentWorkspace({
    repoPrefix: "prompt-library-",
    title: "Prompt Library QA",
  });
  try {
    await openAgentRoute(page, {
      workspaceId: workspace.workspaceId,
      agentId: workspace.agentId,
    });
    await expectComposerVisible(page);

    const button = page.getByTestId("composer-prompt-library-button");
    await expect(button).toBeVisible();
    await button.click();
    await expect(page.getByTestId("prompt-library-picker")).toBeVisible();
    await page.getByTestId("prompt-library-picker-manage").click();
    await expect(page.getByTestId("prompt-library-page")).toBeVisible();
    await expect(page.getByTestId("prompt-library-manager-empty")).toBeVisible();
    await capture(page, "prompt-library-page-empty-wide");

    await createPrompt(page, {
      title: "代码审查",
      body: "请审查这段代码。",
      tags: ["code", "review"],
    });
    await createPrompt(page, {
      title: "发布说明",
      body: "请生成本次发布的说明。",
      tags: ["docs"],
    });
    const library = page.getByTestId("prompt-library-page");
    await expect(library.getByText("代码审查", { exact: true }).first()).toBeVisible();
    await expect(library.getByText("发布说明", { exact: true }).first()).toBeVisible();

    // The left rail filters the list.
    await page.getByTestId("prompt-library-rail-tag-docs").click();
    await expect(library.getByText("代码审查", { exact: true })).toHaveCount(0);
    await page.getByTestId("prompt-library-rail-all").click();
    await expect(library.getByText("代码审查", { exact: true }).first()).toBeVisible();

    // Unsaved changes are confirmed before switching entries.
    const reviewId = await rowIdFor(page, "代码审查");
    await page.getByTestId(`prompt-library-manager-row-${reviewId}`).click();
    await page.getByTestId("prompt-library-manager-title").fill("代码审查（改）");
    page.once("dialog", (dialog) => void dialog.dismiss());
    await library.getByText("发布说明", { exact: true }).first().click();
    await expect(page.getByTestId("prompt-library-manager-title")).toHaveValue("代码审查（改）");
    await page.getByTestId("prompt-library-manager-title").fill("代码审查");
    await closeManager(page);

    // Insert at the caret, preserving existing content.
    await fillComposerDraft(page, "已有内容");
    await button.click();
    const picker = page.getByTestId("prompt-library-picker");
    await expect(picker).toBeVisible();
    await page.getByTestId("prompt-library-picker-search").fill("代码");
    await expect(picker.getByText("发布说明", { exact: true })).toHaveCount(0);
    await picker.getByText("代码审查", { exact: true }).click();
    await expect(page.getByTestId("prompt-library-picker")).toHaveCount(0);
    await expect(composerLocator(page)).toHaveValue("已有内容请审查这段代码。");

    // Tag filter.
    await button.click();
    await page.getByTestId("prompt-library-picker-search").fill("");
    await page.getByTestId("prompt-library-picker-tags-code").click();
    await expect(picker.getByText("代码审查", { exact: true })).toBeVisible();
    await expect(picker.getByText("发布说明", { exact: true })).toHaveCount(0);
    // A second tag intersects: no prompt carries both, and one tap clears the filter.
    await page.getByTestId("prompt-library-picker-tags-docs").click();
    await expect(picker.getByText("代码审查", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("prompt-library-picker-empty")).toBeVisible();
    await page.getByTestId("prompt-library-picker-filter-clear").click();
    await expect(picker.getByText("发布说明", { exact: true })).toBeVisible();
    await closeSheet(page);

    // Rename a tag; the entry follows.
    await openManager(page);
    await page.getByTestId("prompt-library-tag-rename-code").click();
    await page.getByTestId("prompt-library-manager-tag-rename-input").fill("engineering");
    await page.getByTestId("prompt-library-manager-tag-rename-save").click();
    await expect(page.getByTestId("prompt-library-tag-engineering")).toBeVisible();
    await expect(page.getByTestId("prompt-library-tag-code")).toHaveCount(0);
    await closeManager(page);

    await button.click();
    await page.getByTestId("prompt-library-picker-tags-engineering").click();
    await expect(picker.getByText("代码审查", { exact: true })).toBeVisible();
    await expect(picker.getByText("发布说明", { exact: true })).toHaveCount(0);
    await picker.getByText("代码审查", { exact: true }).click();
    await expect(composerLocator(page)).toHaveValue("已有内容请审查这段代码。请审查这段代码。");

    // Offline: take the network away while the page stays mounted so the in-memory composer
    // and the persisted library cache both remain usable.
    await page.context().setOffline(true);
    await fillComposerDraft(page, "离线");
    await button.click();
    await expect(picker).toBeVisible();
    await expect(picker.getByText("代码审查", { exact: true })).toBeVisible();
    await picker.getByText("代码审查", { exact: true }).click();
    await expect(composerLocator(page)).toHaveValue("离线请审查这段代码。");

    await openManager(page);
    await createPrompt(page, {
      title: "离线新增",
      body: "离线时新增的提示词。",
      tags: ["offline"],
    });
    await expect(library.getByText("离线新增", { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId("prompt-library-manager-pending")).toBeVisible();
    await page.waitForTimeout(3_000);
    expect(daemonLibraryText()).not.toContain("离线新增");
    await closeManager(page);

    // Reconnect: the queued prompt reaches the daemon.
    await page.context().setOffline(false);
    await expect.poll(() => daemonLibraryText(), { timeout: 60_000 }).toContain("离线新增");
    await openManager(page);
    await expect(library.getByText("离线新增", { exact: true }).first()).toBeVisible({
      timeout: 30_000,
    });
    await closeManager(page);

    // Chinese UI and responsive screenshots.
    await page.addInitScript(() => {
      const key = "@paseo:app-settings";
      const existing = JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, unknown>;
      localStorage.setItem(key, JSON.stringify({ ...existing, language: "zh-CN" }));
    });
    await page.reload();
    await expect(page.getByTestId("composer-prompt-library-button")).toBeVisible({
      timeout: 60_000,
    });
    await button.click();
    await expect(page.getByTestId("prompt-library-picker")).toBeVisible();
    await waitForSettledPosition(page.getByTestId("prompt-library-picker"));
    await capture(page, "prompt-library-picker-wide");
    await closeSheet(page);

    // The page stays on the settings route from here on: a reload leaves no workspace to return to.
    await page.setViewportSize({ width: 412, height: 915 });
    await button.click();
    await expect(page.getByTestId("prompt-library-picker")).toBeVisible();
    await waitForSettledPosition(page.getByTestId("prompt-library-picker"));
    await page.getByTestId("prompt-library-picker-tags-engineering").click();
    await capture(page, "prompt-library-picker-412");
    await page.getByTestId("prompt-library-picker-manage").click();
    await expect(page.getByTestId("prompt-library-narrow")).toBeVisible();
    await capture(page, "prompt-library-page-412");
    await page.getByTestId("prompt-library-manager-tags").click();
    await capture(page, "prompt-library-tags-412");
    await page.getByTestId("prompt-library-back").click();
    await page.getByTestId("prompt-library-manager-new").click();
    await expect(page.getByTestId("prompt-library-editor")).toBeVisible();
    await capture(page, "prompt-library-editor-412");

    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(page.getByTestId("prompt-library-wide")).toBeVisible();
    await capture(page, "prompt-library-page-wide");
    const wideId = await rowIdFor(page, "代码审查");
    await page.getByTestId(`prompt-library-manager-row-${wideId}`).click();
    await expect(page.getByTestId("prompt-library-editor")).toBeVisible();
    await capture(page, "prompt-library-page-wide-editing");
  } finally {
    await workspace.cleanup();
  }
});
