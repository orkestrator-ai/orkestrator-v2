import { expect, type Locator, type Page } from "@playwright/test";

/** Projects can already be expanded through persisted choices or initial hydration. */
export async function ensureProjectExpanded(page: Page, name: string): Promise<void> {
  const expand = page.getByRole("button", { name: `Expand project ${name}`, exact: true });
  const collapse = page.getByRole("button", { name: `Collapse project ${name}`, exact: true });
  await expect(expand.or(collapse)).toBeVisible({ timeout: 30_000 });
  if (await expand.isVisible()) await expand.click();
  await expect(collapse).toBeVisible();
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
