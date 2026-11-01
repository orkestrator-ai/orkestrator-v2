import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadAppWithDevRetry } from "./dev-startup-retry";

/**
 * Container app wiring in a real browser (todo 0048, task 4), against a
 * profile started with `--fixture-environments local,container`. No provider
 * turns: every change is written straight into the container or worktree.
 *
 * - The Files panel on a container follows changes through its 5 s poll (a
 *   container is an unwatched target), across an inactive-environment switch,
 *   a hidden document, a reload and a second window.
 * - A revert from the Files panel restores the file without a fetch: the
 *   comparison base of a new container is its creation commit.
 * - On a watched local worktree, a tree revision announced while the document
 *   was hidden (the final invalidation the panel skips) still shows after
 *   return.
 * - The project coordinator view opens beside container environments and
 *   survives an environment switch and a reload.
 *
 * Merge from the UI needs a GitHub pull request and validation output needs a
 * workflow with model turns; both are out of reach of this credential-free
 * profile (see the todo).
 */

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const containerName = process.env.ORKESTRATOR_AGENT_TEST_CONTAINER_ENV ?? "fixture-container";
const localName = process.env.ORKESTRATOR_AGENT_TEST_LOCAL_ENV ?? "fixture-local";
/** The Files panel poll (5 s), a read, and margin for a loaded host. */
const POLL_BUDGET_MS = 20_000;

// The direct invoke carries the gateway token; keep it out of artifacts.
test.use({ trace: "off", screenshot: "off", video: "off" });

type Status = { browserUrl?: string; authFile?: string };
type Environment = {
  id: string;
  name: string;
  projectId: string;
  environmentType: string;
  containerId?: string | null;
  worktreePath?: string | null;
};
type FetchCounters = { started: number; requested: number };

function profileStatus(): Status {
  const command = spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (!command.stdout.trim()) throw new Error(command.stderr || "dev:status returned no manifest");
  return JSON.parse(command.stdout) as Status;
}

async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const status = profileStatus();
  const token = (JSON.parse(readFileSync(status.authFile!, "utf8")) as { token: string }).token;
  const response = await fetch(new URL("/__orkestrator/invoke", status.browserUrl!), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ command, args }),
  });
  const payload = (await response.json()) as { result?: T; error?: string };
  if (!response.ok || payload.error) throw new Error(payload.error ?? `${command} failed`);
  return payload.result as T;
}

async function fixtureEnvironment(name: string): Promise<Environment> {
  const projects = await invoke<Array<{ id: string }>>("get_projects");
  for (const project of projects) {
    const environments = await invoke<Environment[]>("get_environments", {
      projectId: project.id,
    });
    const match = environments.find((environment) => environment.name === name);
    if (match) return match;
  }
  throw new Error(`No fixture environment named ${name}`);
}

async function fetchCounters(): Promise<FetchCounters> {
  const diagnostics = await invoke<{
    metrics: { kinds: Record<string, { started: number; requested: number } | undefined> };
  }>("get_recurring_work_diagnostics");
  const kind = diagnostics.metrics.kinds["git-fetch-container"];
  return { started: kind?.started ?? 0, requested: kind?.requested ?? 0 };
}

/** Runs a shell script in the container's workspace as the container user. */
function inContainer(containerId: string, script: string): string {
  const result = spawnSync(
    "docker",
    ["exec", "-u", "node", "-w", "/workspace", containerId, "sh", "-c", script],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr || `docker exec failed: ${script}`);
  return result.stdout;
}

/** This host diagnostic can cover the app; acknowledge it without touching the firewall. */
async function acknowledgeConnectivityWarning(page: Page, testInfo: TestInfo) {
  await page.addLocatorHandler(
    page.getByRole("dialog", { name: "Docker containers can't reach Orkestrator", exact: true }),
    async (dialog) => {
      testInfo.annotations.push({
        type: "environment",
        description: "Acknowledged container-to-host connectivity warning.",
      });
      await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
    },
  );
}

async function login(page: Page, testInfo: TestInfo) {
  await acknowledgeConnectivityWarning(page, testInfo);
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

async function selectEnvironment(page: Page, name: string) {
  const expand = page.getByRole("button", { name: /^Expand project / }).first();
  const collapse = page.getByRole("button", { name: /^Collapse project / }).first();
  await expect(expand.or(collapse)).toBeVisible({ timeout: 30_000 });
  if (await expand.isVisible()) await expand.click();
  const item = page.getByText(name, { exact: true }).first();
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
}

async function openFilesPanel(page: Page) {
  const show = page.getByRole("button", { name: "Show file panel" });
  const hide = page.getByRole("button", { name: "Hide file panel" });
  await expect(show.or(hide)).toBeVisible({ timeout: 30_000 });
  if (await show.isVisible()) await show.click();
  await expect(hide).toBeVisible();
  await page.getByRole("tab", { name: /^Changes/ }).click();
}

/** A changed-file row; both the projection and the legacy list title it by path. */
function changeRow(page: Page, file: string) {
  return page.getByTitle(file, { exact: false }).first();
}

/**
 * Makes the read coordinator see a hidden (or visible again) document. A real
 * hidden tab also throttles timers; the coordinator decides from
 * `visibilityState` and the `visibilitychange` event, which this drives.
 */
async function setDocumentHidden(page: Page, hidden: boolean) {
  await page.evaluate((next) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (next ? "hidden" : "visible"),
    });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => next });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

test("Docker fixture container Files panel follows changes across switch, hidden document, reload and two windows", async ({
  page,
}, testInfo) => {
  test.skip(process.env.ORKESTRATOR_AGENT_TEST_DOCKER !== "1", "Docker fixture profile required");
  test.setTimeout(6 * 60_000);
  const container = await fixtureEnvironment(containerName);
  const containerId = container.containerId;
  if (!containerId) throw new Error(`${containerName} has no container`);
  const run = randomUUID().slice(0, 8);
  const files = ["visible", "inactive", "hidden", "second-window"].map(
    (label) => `qa-wiring-${label}-${run}.txt`,
  );
  const [visibleFile, inactiveFile, hiddenFile, secondWindowFile] = files as [
    string,
    string,
    string,
    string,
  ];
  const cleanup = () =>
    inContainer(
      containerId,
      `rm -f ${files.join(" ")}; git checkout -- README.md 2>/dev/null; true`,
    );

  await page.setViewportSize({ width: 1400, height: 900 });
  await login(page, testInfo);
  try {
    await test.step("the Files panel on a container shows a change made in it", async () => {
      await selectEnvironment(page, containerName);
      await openFilesPanel(page);
      inContainer(containerId, `echo visible > ${visibleFile}`);
      await expect(changeRow(page, visibleFile)).toBeVisible({ timeout: POLL_BUDGET_MS });
    });

    await test.step("a change made while another environment is open shows on return", async () => {
      await selectEnvironment(page, localName);
      await expect(changeRow(page, visibleFile)).toBeHidden({ timeout: 15_000 });
      inContainer(containerId, `echo inactive > ${inactiveFile}`);
      await page.waitForTimeout(6_000);
      await selectEnvironment(page, containerName);
      await openFilesPanel(page);
      await expect(changeRow(page, inactiveFile)).toBeVisible({ timeout: POLL_BUDGET_MS });
      await expect(changeRow(page, visibleFile)).toBeVisible();
    });

    await test.step("a hidden document pauses the poll and catches up on return", async () => {
      await setDocumentHidden(page, true);
      inContainer(containerId, `echo hidden > ${hiddenFile}`);
      // Two poll intervals: a visible panel would have shown it by now.
      await page.waitForTimeout(12_000);
      await expect(changeRow(page, hiddenFile)).toHaveCount(0);
      const returned = Date.now();
      await setDocumentHidden(page, false);
      await expect(changeRow(page, hiddenFile)).toBeVisible({ timeout: POLL_BUDGET_MS });
      testInfo.annotations.push({
        type: "hidden-return",
        description: `change shown ${Date.now() - returned} ms after the document became visible`,
      });
    });

    await test.step("a reload shows the same changes", async () => {
      await page.reload({ waitUntil: "domcontentloaded" });
      await selectEnvironment(page, containerName);
      await openFilesPanel(page);
      for (const file of [visibleFile, inactiveFile, hiddenFile]) {
        await expect(changeRow(page, file)).toBeVisible({ timeout: POLL_BUDGET_MS });
      }
    });

    await test.step("two windows on the same container both follow it", async () => {
      const second = await page.context().newPage();
      await second.setViewportSize({ width: 1400, height: 900 });
      await acknowledgeConnectivityWarning(second, testInfo);
      await loadAppWithDevRetry(second, testInfo, () =>
        second.goto(profileStatus().browserUrl!, { waitUntil: "domcontentloaded" }),
      );
      await selectEnvironment(second, containerName);
      await openFilesPanel(second);
      await expect(changeRow(second, visibleFile)).toBeVisible({ timeout: POLL_BUDGET_MS });
      inContainer(containerId, `echo second > ${secondWindowFile}`);
      await expect(changeRow(page, secondWindowFile)).toBeVisible({ timeout: POLL_BUDGET_MS });
      await expect(changeRow(second, secondWindowFile)).toBeVisible({ timeout: POLL_BUDGET_MS });
      inContainer(containerId, `rm -f ${secondWindowFile}`);
      await expect(changeRow(page, secondWindowFile)).toHaveCount(0, { timeout: POLL_BUDGET_MS });
      await expect(changeRow(second, secondWindowFile)).toHaveCount(0, {
        timeout: POLL_BUDGET_MS,
      });
      await second.close();
    });

    await test.step("a revert from the Files panel restores the file without a fetch", async () => {
      inContainer(containerId, "echo qa-revert >> README.md");
      const row = changeRow(page, "README.md");
      await expect(row).toBeVisible({ timeout: POLL_BUDGET_MS });
      const before = await fetchCounters();
      await row.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Revert", exact: true }).click();
      const dialog = page.getByRole("alertdialog");
      await expect(dialog.getByText("Revert file?")).toBeVisible();
      await dialog.getByRole("button", { name: "Revert", exact: true }).click();
      await expect(page.getByText("File reverted").first()).toBeVisible({ timeout: 30_000 });
      await expect(changeRow(page, "README.md")).toHaveCount(0, { timeout: POLL_BUDGET_MS });
      expect(inContainer(containerId, "git status --porcelain -- README.md").trim()).toBe("");
      // The comparison base is the creation commit: nothing to fetch.
      expect((await fetchCounters()).started).toBe(before.started);
    });
  } finally {
    cleanup();
  }
});

test("Docker fixture local Files panel shows a file whose announcement arrived while hidden", async ({
  page,
}, testInfo) => {
  test.skip(process.env.ORKESTRATOR_AGENT_TEST_DOCKER !== "1", "Docker fixture profile required");
  test.setTimeout(3 * 60_000);
  const local = await fixtureEnvironment(localName);
  if (!local.worktreePath) throw new Error(`${localName} has no worktree`);
  const file = `qa-missed-final-${randomUUID().slice(0, 8)}.txt`;
  const filePath = path.join(local.worktreePath, file);
  const treeEntry = () => page.getByText(file, { exact: true });

  await page.setViewportSize({ width: 1400, height: 900 });
  await login(page, testInfo);
  try {
    await selectEnvironment(page, localName);
    await openFilesPanel(page);
    // The Changes tab is the event-driven change projection, which applies
    // events while hidden. The tree re-reads on announced revisions, and
    // skips one that lands while the document is hidden: the final
    // invalidation is missed and nothing announces it again on return.
    await page.getByRole("tab", { name: "All files", exact: true }).click();
    await expect(page.getByText("README.md", { exact: true }).first()).toBeVisible({
      timeout: 30_000,
    });
    await setDocumentHidden(page, true);
    writeFileSync(filePath, "missed final invalidation\n");
    await page.waitForTimeout(2_000);
    await expect(treeEntry()).toHaveCount(0);
    const returned = Date.now();
    await setDocumentHidden(page, false);
    await expect(treeEntry()).toBeVisible({ timeout: POLL_BUDGET_MS });
    testInfo.annotations.push({
      type: "missed-final-invalidation",
      description: `tree entry shown ${Date.now() - returned} ms after the document became visible`,
    });
  } finally {
    rmSync(filePath, { force: true });
  }
});

test("Docker fixture coordinator view opens beside container environments and survives a reload", async ({
  page,
}, testInfo) => {
  test.skip(process.env.ORKESTRATOR_AGENT_TEST_DOCKER !== "1", "Docker fixture profile required");
  const container = await fixtureEnvironment(containerName);
  await page.setViewportSize({ width: 1400, height: 900 });
  await login(page, testInfo);

  const openCoordinator = async () => {
    const projectRow = page.getByRole("button", { name: /^origin/ }).first();
    await expect(projectRow).toBeVisible({ timeout: 30_000 });
    await projectRow.click();
    const tab = page.getByRole("tab", { name: "Coordinator", exact: true });
    await expect(tab).toBeVisible({ timeout: 15_000 });
    await tab.click();
    const panel = page.locator("#project-panel-coordinator");
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByText("Coordinator unavailable")).toHaveCount(0);
    return panel;
  };

  expect(container.environmentType).toBe("containerized");
  await openCoordinator();
  await selectEnvironment(page, containerName);
  await expect(page.getByRole("button", { name: /^(Show|Hide) file panel$/ })).toBeVisible({
    timeout: 30_000,
  });
  await openCoordinator();
  await page.reload({ waitUntil: "domcontentloaded" });
  await openCoordinator();
});
