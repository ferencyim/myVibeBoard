import { expect, type Locator, type Page } from "@playwright/test";
import { connectDaemonClient } from "./daemon-client-loader";

// ─── Daemon-side seeding ───────────────────────────────────────────────────

interface ModelProviderDaemonClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  patchDaemonConfig(config: {
    providers?: Record<string, Record<string, unknown>>;
    removeProviders?: string[];
  }): Promise<unknown>;
}

export interface HostSeed {
  /** Puts the host's config back the way the test found it and drops the client. */
  restore(): Promise<void>;
}

export interface SeededProviderModel {
  id: string;
  label: string;
  description: string;
}

/**
 * Registers a second provider that reports a fixed catalog. The E2E daemon has
 * exactly one provider with models (`mock`), so nothing cross-provider can be
 * proven without one more.
 *
 * `extends: "mock"` is rejected — the config validator only accepts the six
 * shipped providers plus `acp`. Extending `claude` with a replacement `models`
 * list is what avoids running anything: replacement models skip catalog
 * discovery, and Claude's static modes mean the provider never spawns. The
 * command only has to resolve for the availability probe, hence `node`.
 * Providers with dynamic catalogs can pass a small RPC fixture as `command`.
 */
export async function seedModelProvider(input: {
  id: string;
  label: string;
  models: SeededProviderModel[];
  extends?: "claude" | "pi";
  command?: string[];
}): Promise<HostSeed> {
  const client = await connectDaemonClient<ModelProviderDaemonClient>({
    clientIdPrefix: "model-picker-e2e",
  });
  await client.patchDaemonConfig({
    providers: {
      [input.id]: {
        extends: input.extends ?? "claude",
        label: input.label,
        description: `${input.label} test provider`,
        enabled: true,
        command: input.command ?? ["node"],
        models: input.models,
      },
    },
  });
  return {
    async restore() {
      await client.patchDaemonConfig({ removeProviders: [input.id] }).catch(() => undefined);
      await client.close().catch(() => undefined);
    },
  };
}

// ─── The unified model picker ──────────────────────────────────────────────
//
// One panel for every surface: a popover on wide screens, a bottom sheet on
// compact ones. A rail of provider tabs on the left, the active provider's
// searchable model list on the right, then the effort and fast rows.

/** The visible trigger; a page can hold one per composer. */
export function modelPickerTrigger(page: Page): Locator {
  return page.getByTestId("combined-model-selector").filter({ visible: true }).first();
}

/** The open panel, whichever container (popover or sheet) hosts it. */
export function modelPickerPanel(page: Page): Locator {
  return page.getByTestId("provider-model-picker").filter({ visible: true });
}

export async function openModelPicker(page: Page): Promise<void> {
  if (!(await modelPickerPanel(page).isVisible())) await modelPickerTrigger(page).click();
  await expect(modelPickerPanel(page)).toBeVisible({ timeout: 30_000 });
}

export async function closeModelPicker(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("provider-model-picker")).toHaveCount(0, { timeout: 30_000 });
}

/**
 * Picking a model closes the picker only when the model has no effort or fast row; otherwise the
 * panel stays open so the level can be chosen next. Tests that are done picking close it here.
 */
export async function closeModelPickerIfOpen(page: Page): Promise<void> {
  if (await modelPickerPanel(page).isVisible()) await closeModelPicker(page);
}

/** Switches the rail to a provider's tab. The rail only renders with two or more providers. */
export async function selectProviderTab(page: Page, providerId: string): Promise<void> {
  await modelPickerPanel(page).getByTestId(`provider-model-picker-tab-${providerId}`).click();
}

export async function expectProviderTab(
  page: Page,
  providerId: string,
  visible: boolean,
): Promise<void> {
  const tab = modelPickerPanel(page).getByTestId(`provider-model-picker-tab-${providerId}`);
  if (visible) await expect(tab).toBeVisible({ timeout: 30_000 });
  else await expect(tab).toHaveCount(0);
}

/** Filters the active provider's models; the search never leaves that provider. */
export async function searchModels(page: Page, query: string): Promise<void> {
  const input = modelPickerPanel(page).getByRole("textbox", { name: "搜索模型" });
  await expect(input).toBeVisible({ timeout: 30_000 });
  await input.fill(query);
}

export function modelRow(page: Page, modelId: string): Locator {
  return modelPickerPanel(page).getByTestId(`provider-model-picker-row-${modelId}`);
}

export async function selectModelRow(page: Page, modelId: string): Promise<void> {
  const row = modelRow(page, modelId);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
}

export async function expectModelRowSelected(page: Page, modelId: string): Promise<void> {
  await expect(modelRow(page, modelId)).toHaveAttribute("aria-checked", "true", {
    timeout: 30_000,
  });
}

export async function expectModelRowVisible(
  page: Page,
  modelId: string,
  label?: string,
): Promise<void> {
  const row = modelRow(page, modelId);
  await expect(row).toBeVisible({ timeout: 30_000 });
  if (label !== undefined) await expect(row.getByText(label, { exact: true })).toBeVisible();
}

export async function expectNoModelRow(page: Page, modelId: string): Promise<void> {
  await expect(modelRow(page, modelId)).toHaveCount(0);
}

export async function expectModelSearchEmpty(page: Page): Promise<void> {
  await expect(modelPickerPanel(page).getByText("没有匹配的模型", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
}

/** Picks a segmented effort level by its (localized) label. */
export async function selectEffort(page: Page, label: string): Promise<void> {
  const row = modelPickerPanel(page).getByTestId("provider-model-picker-effort");
  await row.getByRole("radio", { name: label, exact: true }).click();
}

export async function expectEffortSelected(page: Page, label: string): Promise<void> {
  const row = modelPickerPanel(page).getByTestId("provider-model-picker-effort");
  await expect(row.getByRole("radio", { name: label, exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
    { timeout: 30_000 },
  );
}

export async function setFastMode(page: Page, on: boolean): Promise<void> {
  const toggle = modelPickerPanel(page)
    .getByTestId("provider-model-picker-fast")
    .getByRole("switch", { name: "快速模式" });
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  if ((await toggle.getAttribute("aria-checked")) !== String(on)) await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", String(on));
}

export async function readModelPickerBox(page: Page): Promise<{ width: number; height: number }> {
  const box = await modelPickerPanel(page).boundingBox();
  if (!box) throw new Error("Expected the model picker to be laid out");
  return { width: box.width, height: box.height };
}

// ─── Composer trigger ──────────────────────────────────────────────────────

/** The trigger names the model, plus the effort when the model has one: "模型：<model> · <effort>". */
export async function expectComposerModel(page: Page, modelLabel: string): Promise<void> {
  await expect(modelPickerTrigger(page)).toHaveAccessibleName(
    new RegExp(`^模型：${escapeForRegex(modelLabel)}( · .+)?$`),
    { timeout: 30_000 },
  );
}

export async function expectComposerEffort(
  page: Page,
  modelLabel: string,
  effortLabel: string,
): Promise<void> {
  await expect(modelPickerTrigger(page)).toHaveAccessibleName(
    `模型：${modelLabel} · ${effortLabel}`,
    { timeout: 30_000 },
  );
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
