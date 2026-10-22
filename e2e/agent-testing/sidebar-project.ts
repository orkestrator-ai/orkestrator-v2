import { expect, type Page } from "@playwright/test";

/** Projects can already be expanded through persisted choices or initial hydration. */
export async function ensureProjectExpanded(page: Page, name: string): Promise<void> {
  const expand = page.getByRole("button", { name: `Expand project ${name}`, exact: true });
  const collapse = page.getByRole("button", { name: `Collapse project ${name}`, exact: true });
  await expect(expand.or(collapse)).toBeVisible({ timeout: 30_000 });
  if (await expand.isVisible()) await expand.click();
  await expect(collapse).toBeVisible();
}
