import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import path from "node:path";

/**
 * Container lifecycle settings against a real profile started with
 * `--fixture-environments local,container`: the Container and Network
 * sections show backend-owned state (rebuild, resources, staged inputs,
 * recovery copies, the applied network policy) and rehydrate after a reload.
 */

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";

function profileStatus(): { status: string; testProject?: string } {
  const command = spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  return JSON.parse(command.stdout) as { status: string; testProject?: string };
}

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

async function openContainerSettings(page: Page, narrow: boolean) {
  const expand = page.getByRole("button", { name: /^Expand project / }).first();
  const collapse = page.getByRole("button", { name: /^Collapse project / }).first();
  await expect(expand.or(collapse)).toBeVisible({ timeout: 30_000 });
  if (await expand.isVisible()) await expand.click();
  const item = page.getByText("fixture-container", { exact: true }).first();
  await expect(item).toBeVisible({ timeout: 15_000 });
  if (narrow) {
    // Narrow layouts: select the environment (the drawer closes), then open
    // its settings from the Tools drawer.
    await item.click();
    const settings = page.getByRole("button", { name: "Environment settings" }).first();
    if (!(await settings.isVisible().catch(() => false))) {
      await page.getByRole("button", { name: /tools/i }).first().click();
    }
    await settings.click();
    return;
  }
  await item.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Settings" }).click();
}

async function openSection(page: Page, name: string, narrow: boolean) {
  if (narrow) {
    // Narrow layouts pick the section from a select instead of the side nav.
    await page.getByRole("combobox", { name: "Settings section" }).click();
    await page.getByRole("option", { name, exact: true }).click();
  } else {
    await page
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name, exact: true })
      .click();
  }
}

test.skip(process.env.ORKESTRATOR_AGENT_TEST_DOCKER !== "1", "Docker fixture profile required");

for (const viewport of [
  { name: "desktop", width: 1280, height: 860 },
  { name: "narrow", width: 390, height: 844 },
]) {
  test(`Docker fixture container settings show backend state and rehydrate (${viewport.name})`, async ({
    page,
  }) => {
    expect(profileStatus().status).toBe("ready");
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await login(page);

    for (const pass of ["first", "after reload"]) {
      await openContainerSettings(page, viewport.name === "narrow");
      const narrow = viewport.name === "narrow";
      await openSection(page, "Container", narrow);
      await expect(page.getByText("Rebuild container", { exact: true })).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByRole("button", { name: "Rebuild (keeps files)…" })).toBeVisible();
      await expect(page.getByText("Resources", { exact: true })).toBeVisible();
      await expect(page.getByText("Applied by Docker")).toBeVisible();
      await expect(page.getByText("Agent inputs", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Reset container…" })).toBeVisible();
      // A rebuild started outside this page (for example `orkestrator
      // environment recreate`) is reflected from the backend's record.
      if (process.env.ORKESTRATOR_AGENT_TEST_EXPECT_RECOVERY_COPY === "1") {
        await expect(page.getByText("Recovery copies", { exact: true })).toBeVisible({
          timeout: 15_000,
        });
        await expect(page.getByText("Before a rebuild").first()).toBeVisible();
      }

      await openSection(page, "Network", narrow);
      await expect(page.getByText("Applied in the container")).toBeVisible({ timeout: 15_000 });

      // The preserving rebuild preview is available for this capable image.
      await openSection(page, "Container", narrow);
      await page.getByRole("button", { name: "Rebuild (keeps files)…" }).click();
      await expect(page.getByText("Rebuild container and keep its files?")).toBeVisible({
        timeout: 30_000,
      });
      await page.getByRole("button", { name: "Close" }).click();
      if (pass === "first") await page.reload({ waitUntil: "domcontentloaded" });
    }
  });
}
