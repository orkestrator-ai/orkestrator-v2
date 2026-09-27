import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import path from "node:path";

/**
 * A preserving rebuild driven from the real renderer against a profile started
 * with `--fixture-environments local,container` (C29): the user starts it,
 * switches to another environment while it runs, comes back to backend-owned
 * progress, and after it completes sees the previous container as a recovery
 * copy — also after a reload. The Docker dialog's reviewed cleanup lists
 * nothing it would remove from a live environment.
 */

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";

async function login(page: Page) {
  // The one-shot login URL is parsed in memory and never copied into output.
  const command = spawnSync("mise", ["run", "dev:login", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (command.status !== 0) throw new Error(command.stderr || "dev:login failed");
  const { loginUrl } = JSON.parse(command.stdout) as { loginUrl?: unknown };
  if (typeof loginUrl !== "string") throw new Error("dev:login returned no login URL");
  await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
}

async function environmentItem(page: Page, name: string) {
  const expand = page.getByRole("button", { name: /^Expand project / }).first();
  const collapse = page.getByRole("button", { name: /^Collapse project / }).first();
  await expect(expand.or(collapse)).toBeVisible({ timeout: 30_000 });
  if (await expand.isVisible()) await expand.click();
  const item = page.getByText(name, { exact: true }).first();
  await expect(item).toBeVisible({ timeout: 15_000 });
  return item;
}

async function openContainerSection(page: Page) {
  const item = await environmentItem(page, "fixture-container");
  await item.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Container", exact: true })
    .click();
  await expect(page.getByText("Rebuild container", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
}

test.skip(process.env.ORKESTRATOR_AGENT_TEST_DOCKER !== "1", "Docker fixture profile required");

test("a rebuild keeps running while another environment is open and rehydrates", async ({
  page,
}) => {
  test.setTimeout(8 * 60_000);
  await page.setViewportSize({ width: 1280, height: 860 });
  await login(page);

  await openContainerSection(page);
  await page.getByRole("button", { name: "Rebuild (keeps files)…" }).click();
  await expect(page.getByText("Rebuild container and keep its files?")).toBeVisible({
    timeout: 30_000,
  });
  // The confirmation closes the settings; the rebuild runs in the backend.
  await page.getByRole("button", { name: "Rebuild", exact: true }).click();

  // Switch away at once: the initiating settings view is gone.
  await (await environmentItem(page, "fixture-local")).click();
  await page.waitForTimeout(2_000);

  // Back: the section reads progress (or the finished result) from the
  // backend's record, not from the view that started it.
  await openContainerSection(page);
  await expect(page.getByText("Recovery copies", { exact: true })).toBeVisible({
    timeout: 5 * 60_000,
  });
  await expect(page.getByText("Before a rebuild").first()).toBeVisible();
  await expect(page.getByText(/Rebuilding…|Copying and verifying files…/)).toHaveCount(0);

  // A reload rehydrates the same state from the backend.
  await page.reload({ waitUntil: "domcontentloaded" });
  await openContainerSection(page);
  await expect(page.getByText("Before a rebuild").first()).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Escape");

  // Reviewed cleanup never offers the live environment's resources.
  await page.getByRole("button", { name: "Docker configuration" }).click();
  await page.getByRole("button", { name: /Review cleanup/ }).click();
  await expect(
    page.getByText(/Review Docker cleanup|Nothing to clean up|can be removed/i).first(),
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("In use by an environment").first()).toBeVisible();
});
