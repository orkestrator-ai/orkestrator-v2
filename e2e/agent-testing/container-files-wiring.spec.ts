import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  POLL_BUDGET_MS,
  containerName,
  fixtureEnvironment,
  inContainer,
  invoke,
  localName,
  login,
  openSecondWindow,
  reloadApp,
  selectEnvironment,
  setDocumentHidden,
} from "./container-wiring-support";

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
 *
 * Merge from the UI, validation output and the coordinator view are in
 * `container-app-wiring.spec.ts`.
 */

// The direct invoke carries the gateway token; keep it out of artifacts.
test.use({ trace: "off", screenshot: "off", video: "off" });

type FetchCounters = { started: number; requested: number };

async function fetchCounters(): Promise<FetchCounters> {
  const diagnostics = await invoke<{
    metrics: { kinds: Record<string, { started: number; requested: number } | undefined> };
  }>("get_recurring_work_diagnostics");
  const kind = diagnostics.metrics.kinds["git-fetch-container"];
  return { started: kind?.started ?? 0, requested: kind?.requested ?? 0 };
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
      await reloadApp(page, testInfo);
      await selectEnvironment(page, containerName);
      await openFilesPanel(page);
      for (const file of [visibleFile, inactiveFile, hiddenFile]) {
        await expect(changeRow(page, file)).toBeVisible({ timeout: POLL_BUDGET_MS });
      }
    });

    await test.step("two windows on the same container both follow it", async () => {
      const second = await openSecondWindow(page.context(), testInfo);
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
    const observedTreeRevision = () =>
      page.evaluate(async (environmentId) => {
        const modulePath = "/src/stores/worktreeSnapshotStore.ts";
        const { useWorktreeSnapshotStore } = await import(/* @vite-ignore */ modulePath);
        return useWorktreeSnapshotStore.getState().entries.get(environmentId)?.treeRevision ?? 0;
      }, local.id);
    await expect.poll(observedTreeRevision).toBeGreaterThan(0);
    const beforeRevision = await observedTreeRevision();
    await setDocumentHidden(page, true);
    writeFileSync(filePath, "missed final invalidation\n");
    // Prove the renderer received the invalidation while hidden. A watcher
    // event delayed until after return must not satisfy this regression.
    await expect
      .poll(observedTreeRevision, { timeout: POLL_BUDGET_MS })
      .toBeGreaterThan(beforeRevision);
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
