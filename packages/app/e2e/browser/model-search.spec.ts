import path from "node:path";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { test, expect, type Page } from "../support/fixtures";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import {
  closeModelPicker,
  expectModelRowVisible,
  expectModelSearchEmpty,
  expectNoModelRow,
  modelRow,
  openModelPicker,
  readModelPickerBox,
  searchModels,
  seedModelProvider,
  selectProviderTab,
} from "../support/helpers/model-picker";
import { expectComposerVisible } from "../support/helpers/composer";
import { clickNewChat, clickNewTerminal, gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";

// Its fast model deliberately carries the same label as the mock provider's. Search is scoped to
// the active provider tab, so each tab lists its own "Ten second stream" and never the other's.
const STUDIO = {
  id: "mock-studio",
  label: "Mock Studio",
  models: [
    { id: "studio-fast", label: "Ten second stream", description: "Studio quick pass" },
    { id: "studio-deep", label: "Studio deep think", description: "Studio long pass" },
  ],
};

const LARGE_CATALOG_SIZE = 200;
const LARGE_CATALOG = {
  id: "mock-bulk",
  label: "Mock Bulk",
  models: Array.from({ length: LARGE_CATALOG_SIZE }, (_, index) => ({
    id: `bulk-${index}`,
    label: `Bulk model ${index}`,
    description: `Bulk search result ${index}`,
  })),
};

async function openDraftPicker(page: Page, workspaceId: string) {
  await gotoWorkspace(page, workspaceId);
  await clickNewChat(page);
  await expectComposerVisible(page);
  await openModelPicker(page);
}

test.describe("Model search", () => {
  test("search filters the active provider's list and resets when the tab changes", async ({
    page,
  }) => {
    const provider = await seedModelProvider(STUDIO);
    const workspace = await seedWorkspace({ repoPrefix: "model-search-providers-" });

    try {
      await test.step("open a draft composer with two providers", async () => {
        await openDraftPicker(page, workspace.workspaceId);
        await selectProviderTab(page, STUDIO.id);
        await expectModelRowVisible(page, "studio-fast", "Ten second stream");
      });
      const resting = await readModelPickerBox(page);

      await test.step("a query narrows the list to matching models of that provider", async () => {
        await searchModels(page, "studio deep");
        await expectModelRowVisible(page, "studio-deep", "Studio deep think");
        await expectNoModelRow(page, "studio-fast");
        expect(await readModelPickerBox(page)).toEqual(resting);
      });

      await test.step("the same label under another provider stays on its own tab", async () => {
        await selectProviderTab(page, "mock");
        await expectModelRowVisible(page, "ten-second-stream", "Ten second stream");
        await expectNoModelRow(page, "studio-fast");
        await selectProviderTab(page, STUDIO.id);
        await expectModelRowVisible(page, "studio-fast", "Ten second stream");
        await expectModelRowVisible(page, "studio-deep");
      });

      await test.step("a query with no matches shows the empty state", async () => {
        await searchModels(page, "zzz");
        await expectModelSearchEmpty(page);
        await closeModelPicker(page);
      });
    } finally {
      await workspace.cleanup();
      await provider.restore();
    }
  });

  test("a 200-model catalog narrows to one row without resizing the picker", async ({ page }) => {
    const provider = await seedModelProvider(LARGE_CATALOG);
    const workspace = await seedWorkspace({ repoPrefix: "model-search-large-catalog-" });

    try {
      await openDraftPicker(page, workspace.workspaceId);
      await selectProviderTab(page, LARGE_CATALOG.id);
      await expectModelRowVisible(page, "bulk-0", "Bulk model 0");
      const resting = await readModelPickerBox(page);

      await searchModels(page, "bulk model 199");
      await expectModelRowVisible(page, "bulk-199", "Bulk model 199");
      await expectNoModelRow(page, "bulk-0");
      await expect.poll(() => readModelPickerBox(page)).toEqual(resting);
    } finally {
      await workspace.cleanup();
      await provider.restore();
    }
  });
});

async function setRuntimeCatalog(client: DaemonClient, count: number, cwd: string) {
  await client.patchDaemonConfig({
    providers: {
      gemini: {
        extends: "acp",
        label: "Catalog provider",
        enabled: true,
        command: [
          process.execPath,
          path.resolve(__dirname, "../support/fixtures/catalog-acp.cjs"),
          String(count),
        ],
      },
    },
  });
  await expect
    .poll(
      async () =>
        (await client.getProvidersSnapshot({ cwd })).entries.find(
          (entry) => entry.provider === "gemini",
        )?.status,
      { timeout: 30_000 },
    )
    .toBe("ready");
}
async function reloadSavedDraft(page: Page) {
  await page.evaluate(() =>
    localStorage.setItem(
      "@paseo:e2e-disable-default-seed-once",
      localStorage.getItem("@paseo:e2e-seed-nonce")!,
    ),
  );
  await page.reload();
  await expectComposerVisible(page);
}
async function expectOneCatalogChoice(page: Page, label: string) {
  await openModelPicker(page);
  await selectProviderTab(page, "gemini");
  await searchModels(page, label);
  await expect(modelRow(page, "gemini-3.5-flash")).toHaveCount(1);
  await closeModelPicker(page);
}

async function configureModelOverride(client: DaemonClient, cwd: string) {
  await client.patchDaemonConfig({
    providers: {
      gemini: {
        additionalModels: [{ id: "gemini-3.5-flash", label: "Configured model", isDefault: true }],
      },
    },
  });
  await expect
    .poll(
      async () =>
        (await client.getProvidersSnapshot({ cwd: cwd })).entries.find(
          (entry) => entry.provider === "gemini",
        )?.models,
      { timeout: 30_000 },
    )
    .toMatchObject([{ id: "gemini-3.5-flash", label: "Configured model", isDefault: true }]);
}

const catalogTest = test.extend<{ catalogClient: DaemonClient }>({
  catalogClient: async ({ e2eWorker }, provide) => {
    void e2eWorker;
    const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "catalog-models" });
    try {
      await provide(client);
    } finally {
      try {
        await client.patchDaemonConfig({ removeProviders: ["gemini"] });
      } finally {
        await client.close();
      }
    }
  },
});

catalogTest(
  "New Agent and saved drafts stay usable with repeated runtime model rows",
  async ({ page, withWorkspace, catalogClient: client }, testInfo) => {
    const workspace = await withWorkspace({ prefix: "catalog-models-" });
    await test.step("open a draft with a one-row runtime catalog", async () => {
      await setRuntimeCatalog(client, 1, workspace.repoPath);
      await gotoWorkspace(page, workspace.workspaceId);
      await clickNewChat(page);
      await expectComposerVisible(page);
    });
    await test.step("open New Agent after the provider publishes repeated model rows", async () => {
      await clickNewTerminal(page);
      await setRuntimeCatalog(client, 2, workspace.repoPath);
      await clickNewChat(page);
      await expectComposerVisible(page);
      await expectOneCatalogChoice(page, "Gemini 3.5 Flash");
      await page.screenshot({ path: testInfo.outputPath("duplicate-catalog-draft.png") });
    });
    await test.step("reopen the saved draft with the same catalog", async () => {
      await reloadSavedDraft(page);
      await expectOneCatalogChoice(page, "Gemini 3.5 Flash");
    });
    await test.step("retain configured model overrides when runtime IDs repeat", async () => {
      await configureModelOverride(client, workspace.repoPath);
      await reloadSavedDraft(page);
      await expectOneCatalogChoice(page, "Configured model");
    });
  },
);
