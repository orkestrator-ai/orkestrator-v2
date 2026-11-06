import { expect, test } from "./browser-test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  invoke,
  login,
  profileStatus,
  reloadApp,
  selectEnvironment,
} from "./container-wiring-support";
import { ensureProjectExpanded, sidebarEnvironmentRow } from "./sidebar-project";

// Direct invokes use the profile credential; never capture their headers.
test.use({ trace: "off", screenshot: "off", video: "off" });

// Deleting needs no agent, Docker or GitHub CLI, so a credential-free profile
// reaches the workspace through the ordinary optional-tool dialogs.
test.beforeEach(async ({ page }) => {
  for (const name of [
    "Continue Without Claude",
    "Continue Without Docker",
    "Continue Without GitHub CLI",
  ]) {
    await page.addLocatorHandler(page.getByRole("button", { name, exact: true }), (button) =>
      button.click(),
    );
  }
});

test("a real delete failure persists across inactive views and reload, then Retry completes it", async ({
  page,
}, testInfo) => {
  test.skip(process.getuid?.() === 0, "the fixture needs non-root directory permissions");
  test.setTimeout(120_000);
  const status = profileStatus() as ReturnType<typeof profileStatus> & {
    dataDir: string;
    testProject: string;
  };
  const project = (
    await invoke<Array<{ id: string; name: string; localPath: string }>>("get_projects")
  ).find((candidate) => candidate.localPath === status.testProject)!;
  expect(project).toBeTruthy();
  const suffix = randomUUID().slice(0, 8);
  const create = (name: string) =>
    invoke<{ id: string; name: string }>("create_environment", {
      projectId: project.id,
      name,
      environmentType: "local",
      branch: "main",
    });
  const target = await create(`delete-retry-${suffix}`);
  const other = await create(`delete-other-${suffix}`);
  const seed = path.join(status.dataDir, "node-seed", target.id);
  await fs.mkdir(seed, { recursive: true });
  await fs.writeFile(path.join(seed, "fixture"), "");
  const record = async () =>
    (
      await invoke<Array<{ id: string; deletionError?: string; deletionRequestedAt?: string }>>(
        "get_environments",
        { projectId: project.id },
      )
    ).find((env) => env.id === target.id);
  try {
    await login(page, testInfo);
    await selectEnvironment(page, other.name);
    // Only this environment's disposable seed directory is made unwritable.
    // This fails a real delete step after its durable tombstone exists.
    await fs.chmod(seed, 0o500);
    await expect(invoke("delete_environment", { environmentId: target.id })).rejects.toThrow();
    await expect.poll(async () => Boolean((await record())?.deletionError)).toBe(true);
    const failed = await record();
    expect(failed?.deletionRequestedAt).toBeTruthy();
    await reloadApp(page, testInfo);
    await ensureProjectExpanded(page, project.name);
    const row = sidebarEnvironmentRow(page, target.name).locator("..");
    await expect(row.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    await expect(row).toContainText(failed!.deletionError!);
    await expect(row.locator(".animate-spin")).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 900 });
    await fs.mkdir(path.join(process.cwd(), "output/visual-previews"), { recursive: true });
    await page.screenshot({ path: "output/visual-previews/delete-retry-real-failure.png" });
    await fs.chmod(seed, 0o700);
    await row.getByRole("button", { name: "Retry", exact: true }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: /^Delete(?: on .+)?$/ })
      .click();
    await expect.poll(record).toBeUndefined();
    await expect(sidebarEnvironmentRow(page, target.name)).toHaveCount(0);
    await reloadApp(page, testInfo);
    await ensureProjectExpanded(page, project.name);
    await expect(sidebarEnvironmentRow(page, target.name)).toHaveCount(0);
    expect(await record()).toBeUndefined();
  } finally {
    await fs.chmod(seed, 0o700).catch(() => undefined);
    for (const env of [target, other])
      await invoke("delete_environment", { environmentId: env.id }).catch(() => undefined);
  }
});

test("a delete started from the row fails on a surviving terminal, survives reload, and Retry finishes it", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const status = profileStatus() as ReturnType<typeof profileStatus> & {
    dataDir: string;
    testProject: string;
  };
  const project = (
    await invoke<Array<{ id: string; name: string; localPath: string }>>("get_projects")
  ).find((candidate) => candidate.localPath === status.testProject)!;
  expect(project).toBeTruthy();
  const suffix = randomUUID().slice(0, 8);
  const create = (name: string) =>
    invoke<{ id: string; name: string }>("create_environment", {
      projectId: project.id,
      name,
      environmentType: "local",
      branch: "main",
    });
  const target = await create(`delete-terminal-${suffix}`);
  const other = await create(`delete-bystander-${suffix}`);
  // The agent-test backend leaves this environment's terminal trees running
  // through a delete while the marker exists (agent-test-fixtures.ts).
  const marker = path.join(
    status.dataDir,
    "agent-test-fixtures",
    "terminal-survives-terminate",
    target.id,
  );
  const record = async () =>
    (
      await invoke<Array<{ id: string; deletionError?: string; deletionRequestedAt?: string }>>(
        "get_environments",
        { projectId: project.id },
      )
    ).find((env) => env.id === target.id);
  try {
    // A local environment's worktree exists once it has started.
    await invoke("start_environment", { environmentId: target.id });
    const terminal = await invoke<{ sessionId: string }>("create_local_terminal_session", {
      environmentId: target.id,
      terminalKey: `delete-survivor-${suffix}`,
      cols: 80,
      rows: 24,
    });
    await invoke("start_local_terminal_session", { sessionId: terminal.sessionId });
    await fs.mkdir(path.dirname(marker), { recursive: true });
    await fs.writeFile(marker, "");

    await login(page, testInfo);
    await selectEnvironment(page, other.name);
    await ensureProjectExpanded(page, project.name);
    const name = sidebarEnvironmentRow(page, target.name);
    await name.dispatchEvent("contextmenu", { button: 2 });
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: /^Delete(?: on .+)?$/ })
      .click();
    await expect
      .poll(async () => (await record())?.deletionError ?? "")
      .toContain("Terminal process trees are still running");
    const failed = await record();
    expect(failed?.deletionRequestedAt).toBeTruthy();

    await reloadApp(page, testInfo);
    await ensureProjectExpanded(page, project.name);
    const row = sidebarEnvironmentRow(page, target.name).locator("..");
    await expect(row.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    await expect(row).toContainText(failed!.deletionError!);
    await expect(row.locator(".animate-spin")).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 900 });
    // The startup tool check blurs the window; wait it out for a readable picture.
    await expect(page.getByText("Checking CLI tools installation...", { exact: true })).toBeHidden({
      timeout: 30_000,
    });
    await fs.mkdir(path.join(process.cwd(), "output/visual-previews"), { recursive: true });
    await page.screenshot({ path: "output/visual-previews/delete-retry-surviving-terminal.png" });

    // The terminal is still there; without the marker the retry terminates it.
    await fs.rm(marker);
    await row.getByRole("button", { name: "Retry", exact: true }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: /^Delete(?: on .+)?$/ })
      .click();
    await expect.poll(record).toBeUndefined();
    await reloadApp(page, testInfo);
    await ensureProjectExpanded(page, project.name);
    await expect(sidebarEnvironmentRow(page, target.name)).toHaveCount(0);
  } finally {
    await fs.rm(marker, { force: true }).catch(() => undefined);
    for (const env of [target, other])
      await invoke("delete_environment", { environmentId: env.id }).catch(() => undefined);
  }
});
