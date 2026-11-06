import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Leaves a project expanded by the user's own choice. A project the sidebar has
 * not finished hydrating shows expanded, and once its environments load an empty
 * one collapses itself (`collapseEmptyProjects`), unless the user has already
 * chosen. Seeing "Collapse" is therefore not enough: toggle until the expanded
 * state is a recorded choice, which the auto-collapse leaves alone.
 */
export async function ensureProjectExpanded(
  page: Page,
  name: string,
  timeout = 30_000,
): Promise<void> {
  const expand = page.getByRole("button", { name: `Expand project ${name}`, exact: true });
  const collapse = page.getByRole("button", { name: `Collapse project ${name}`, exact: true });
  await expect(expand.or(collapse)).toBeVisible({ timeout });
  await expect(async () => {
    if (await collapse.isVisible()) await collapse.click({ timeout: 2_000 });
    await expand.click({ timeout: 2_000 });
    await expect(collapse).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

/**
 * An environment's sidebar row button. A client that can show several machines
 * labels it `<name>, on <machine>, <activity>`; otherwise its name comes from
 * its content, starting with the environment name. Both start with the name
 * followed by a comma, whitespace or nothing, so a longer name never matches.
 */
export function sidebarEnvironmentRow(page: Page, environmentName: string): Locator {
  const escaped = environmentName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return page.getByRole("button", { name: new RegExp(`^${escaped}([,\\s]|$)`) }).first();
}
