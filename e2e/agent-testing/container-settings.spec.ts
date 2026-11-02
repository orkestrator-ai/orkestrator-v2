import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { promises as fs } from "node:fs";
import { environmentStateDirectory } from "../../apps/backend/src/core/environment-state-paths";
import { loadAppWithDevRetry } from "./dev-startup-retry";

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

async function login(page: Page, testInfo: TestInfo) {
  // The one-shot login URL is parsed in memory and never copied into output.
  const command = spawnSync("mise", ["run", "dev:login", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (command.status !== 0) throw new Error(command.stderr || "dev:login failed");
  const { loginUrl } = JSON.parse(command.stdout) as { loginUrl?: unknown };
  if (typeof loginUrl !== "string") throw new Error("dev:login returned no login URL");
  await loadAppWithDevRetry(page, testInfo, () =>
    page.goto(loginUrl, { waitUntil: "domcontentloaded" }),
  );
}

async function openContainerSettings(page: Page, narrow: boolean) {
  const projects = page.getByRole("button", {
    name: "Open projects and environments",
    exact: true,
  });
  const drawer = page.getByRole("dialog", { name: "Projects and environments", exact: true });
  if (narrow) {
    await expect(drawer.or(projects)).toBeVisible({ timeout: 30_000 });
    if (!(await drawer.isVisible())) await projects.click();
    await expect(drawer).toBeVisible();
  }
  const expand = page.getByRole("button", { name: /^Expand project / }).first();
  const collapse = page.getByRole("button", { name: /^Collapse project / }).first();
  await expect(expand.or(collapse)).toBeVisible({ timeout: 30_000 });
  if (await expand.isVisible()) await expand.click();
  const item = page.getByText("fixture-container", { exact: true }).first();
  await expect(item).toBeVisible({ timeout: 15_000 });
  if (narrow) {
    // Narrow layouts: select the environment (the drawer closes), then open
    // its settings from the bottom bar of the reopened drawer.
    await item.click();
    await expect(drawer).toBeHidden();
    await projects.click();
    await drawer.getByRole("button", { name: "Environment settings", exact: true }).click();
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
  }, testInfo) => {
    expect(profileStatus().status).toBe("ready");
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await login(page, testInfo);

    for (const pass of ["first", "after reload"]) {
      await openContainerSettings(page, viewport.name === "narrow");
      const narrow = viewport.name === "narrow";
      await openSection(page, "Container", narrow);
      await expect(page.getByText("Rebuild container", { exact: true })).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByRole("button", { name: "Rebuild (keeps files)…" })).toBeVisible();
      await expect(page.getByText("Resources", { exact: true })).toBeVisible();
      await expect(page.getByText("Applied by Docker", { exact: true })).toBeVisible();
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

test("Docker fixture withheld login summary survives switching away and reload", async ({
  page,
}, testInfo) => {
  const result = spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  const status = JSON.parse(result.stdout) as {
    dataDir: string;
    browserUrl: string;
    testProject: string;
  };
  await login(page, testInfo);
  const invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const response = await page.request.post(
      new URL("/__orkestrator/invoke", status.browserUrl).href,
      { data: { command, args } },
    );
    expect(response.ok()).toBe(true);
    return (await response.json()).result;
  };
  const projects = await invoke<Array<{ id: string; localPath: string }>>("get_projects");
  const project = projects.find((entry) => entry.localPath === status.testProject)!;
  const environments = await invoke<Array<{ id: string; name: string }>>("get_environments", {
    projectId: project.id,
  });
  const environment = environments.find((entry) => entry.name === "fixture-container")!;
  const inputs = await invoke<{ revision: string }>("get_environment_inputs", {
    environmentId: environment.id,
  });
  const file = path.join(
    environmentStateDirectory(status.dataDir, "portable-inputs", environment.id),
    inputs.revision,
    "manifest.json",
  );
  const original = await fs.readFile(file, "utf8");
  // Seed a content-free persisted staging result. The staging unit test proves
  // expiry produces this record; the real backend and renderer must rehydrate it.
  const manifest = JSON.parse(original);
  manifest.providers = [
    ...manifest.providers.filter((entry: { provider: string }) => entry.provider !== "grok"),
    { provider: "grok", files: 0, bytes: 0, skipped: { "login-withheld": 1 } },
  ];
  try {
    await fs.writeFile(file, JSON.stringify(manifest), { mode: 0o600 });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 860 });
      for (const pass of ["first", "reload"]) {
        await openContainerSettings(page, width === 390);
        await openSection(page, "Container", width === 390);
        await expect(
          page.getByText(/Login withheld\. Sign in to Grok Build on the host/),
        ).toBeVisible();
        await expect(page.getByText(/Grok Build · 0 files · 0 B · 1 skipped/)).toBeVisible();
        await page.getByRole("button", { name: "Close settings", exact: true }).click();
        if (pass === "first") {
          // The inputs view is unmounted while another environment is active.
          const item = page.getByText("fixture-local", { exact: true }).first();
          if (await item.isVisible()) await item.click();
          await page.reload({ waitUntil: "domcontentloaded" });
        }
      }
    }
  } finally {
    await fs.writeFile(file, original, { mode: 0o600 });
  }
});
