/**
 * The Changes tab's remote freshness in a real browser (todo 0048 task 19,
 * docs/todo/transcripts-and-observation/0048-recurring-work-qualification.md):
 * what `WorktreeSnapshotState.remote` says about a container's comparison base,
 * and the "Base may be behind remote" / "Base not fetched yet" strips
 * (`remoteFreshnessNotice`, `view-freshness.ts`) that show it.
 *
 * Every new container compares against its creation commit, which never
 * fetches, so its remote state is `not-required` and no strip shows; the
 * first case checks exactly that. Only a container whose record has no
 * `createdFromCommit` (a record whose setup finished before the field
 * existed) compares against a branch and reaches the fetch policy's other
 * states. The second case needs one, made the way decision 12 of 0048 made it:
 * stop the profile, remove `createdFromCommit` from the container
 * environment's row in the profile's own `orkestrator.sqlite`, and start it
 * again without `--fixture`.
 *
 *   ORKESTRATOR_HOST_REACHABILITY_CHECK=off mise run dev:test --profile q48mac --fixture \
 *     --fixture-environments local,container --no-agent-credentials --agent-platforms pi
 *   ORKESTRATOR_AGENT_TEST_PROFILE=q48mac ORKESTRATOR_AGENT_TEST_DOCKER=1 \
 *     ORKESTRATOR_AGENT_TEST_REMOTE_FRESHNESS=1 mise run test:logged -- --name remote-freshness -- \
 *     bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts \
 *     changes-remote-freshness.spec.ts --workers=1
 *
 * The remote is the fixture's bare origin, bind-mounted into the container.
 * It is advanced from a second checkout on the host, and a remote read fails
 * because the container's `origin` URL is pointed at a missing path for the
 * duration of that step (restored in `finally`). No provider turn, GitHub or
 * firewall change is involved. Output is states and milliseconds only.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  WorktreeRemoteFreshnessState,
  WorktreeSnapshotState,
} from "@orkestrator/protocol/worktree-snapshots";
import { expect, test, type Page } from "./browser-test";
import {
  containerName,
  fixtureEnvironment,
  inContainer,
  invoke,
  localName,
  login,
  reloadApp,
  selectEnvironment,
} from "./container-wiring-support";

const LIVE = process.env.ORKESTRATOR_AGENT_TEST_REMOTE_FRESHNESS === "1";
/** An explicit refresh within 15 s of the last attempt joins it (`container-git-fetch.ts`). */
const EXPLICIT_MIN_INTERVAL_MS = 16_000;

test.describe.configure({ mode: "serial" });
// The direct invoke carries the gateway token; keep it out of artifacts.
test.use({ trace: "off", screenshot: "off", video: "off" });
test.skip(
  !LIVE || process.env.ORKESTRATOR_AGENT_TEST_DOCKER !== "1",
  "Set ORKESTRATOR_AGENT_TEST_REMOTE_FRESHNESS=1 and ORKESTRATOR_AGENT_TEST_DOCKER=1 against a disposable container profile",
);

// One line a minute, so `test:logged`'s no-output watchdog (5 min) does not
// end a long, quiet probe loop. No content, only the test's title.
let progress: ReturnType<typeof setInterval> | undefined;
test.beforeEach(() => {
  const { title } = test.info();
  progress = setInterval(() => console.log(`still running: ${title}`), 60_000);
});
test.afterEach(() => clearInterval(progress));

async function snapshot(environmentId: string): Promise<WorktreeSnapshotState> {
  const revisions = await invoke<{ entries: WorktreeSnapshotState[] }>(
    "get_worktree_snapshot_revisions",
  );
  const entry = revisions.entries.find((candidate) => candidate.environmentId === environmentId);
  if (!entry) throw new Error("the environment has no worktree snapshot");
  return entry;
}

/** The remote strip the Changes tab shows: its `data-freshness` kind, or null. */
async function strip(page: Page): Promise<string | null> {
  return page
    .evaluate(
      () =>
        document
          .querySelector('[role="status"][data-freshness^="remote-"]')
          ?.getAttribute("data-freshness") ?? null,
    )
    .catch(() => null);
}

/** The strip `remoteFreshnessNotice` derives from a backend state. */
function expectedStrip(remote: WorktreeSnapshotState["remote"]): string | null {
  if (remote?.state === "stale") return "remote-stale";
  if (remote?.state === "unknown") return "remote-unknown";
  return null;
}

async function openChanges(page: Page) {
  const show = page.getByRole("button", { name: "Show file panel" });
  const hide = page.getByRole("button", { name: "Hide file panel" });
  await expect(show.or(hide)).toBeVisible({ timeout: 30_000 });
  if (await show.isVisible()) await show.click();
  await expect(hide).toBeVisible();
  await page.getByRole("tab", { name: /^Changes/ }).click();
}

async function msUntil(
  since: number,
  done: () => Promise<boolean>,
  label: string,
  timeoutMs = 90_000,
) {
  for (;;) {
    if (await done()) return Date.now() - since;
    if (Date.now() - since > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

test("a new container's comparison base never fetches, so the Changes tab shows no remote strip", async ({
  page,
}, testInfo) => {
  const container = await fixtureEnvironment(containerName);
  const state = await snapshot(container.id);
  test.skip(
    state.remote !== undefined && state.remote.state !== "not-required",
    "This container is a legacy record; the next case covers it",
  );
  await page.setViewportSize({ width: 1400, height: 900 });
  await login(page, testInfo);
  await selectEnvironment(page, containerName);
  await openChanges(page);
  // Give the panel a full container scan to show anything it would.
  await page.waitForTimeout(16_000);
  const after = await snapshot(container.id);
  testInfo.annotations.push({
    type: "new container",
    description: JSON.stringify({
      comparisonRefIsCommit: /^[0-9a-f]{40}$/.test(after.comparisonRef),
      remote: after.remote?.state ?? "absent",
      strip: await strip(page),
    }),
  });
  expect(after.remote?.state ?? "not-required").toBe("not-required");
  expect(await strip(page)).toBeNull();
});

test("a legacy container's remote strip follows fetch success, failure, a switch, a reload and recovery", async ({
  page,
}, testInfo) => {
  test.setTimeout(15 * 60_000);
  const container = await fixtureEnvironment(containerName);
  const containerId = container.containerId;
  if (!containerId) throw new Error(`${containerName} has no container`);
  const initial = await snapshot(container.id);
  test.skip(
    initial.remote === undefined || initial.remote.state === "not-required",
    "Needs a container record without createdFromCommit (see the file comment)",
  );
  const comparisonRef = initial.comparisonRef;
  const branch = comparisonRef.replace(/^origin\//, "");
  const run = randomUUID().slice(0, 6);
  const remoteFile = `0-remote-advance-${run}.txt`;
  const steps: Array<Record<string, unknown>> = [];
  const record = async (step: string, extra: Record<string, unknown> = {}) => {
    const state = await snapshot(container.id);
    const entry = {
      step,
      backend: state.remote?.state ?? "absent",
      failure: state.remote?.failure ?? null,
      strip: await strip(page),
      ...extra,
    };
    steps.push(entry);
    return entry;
  };
  const refreshAt = async () => {
    const button = page.getByRole("button", { name: "Refresh", exact: true });
    await expect(button).toBeEnabled({ timeout: 30_000 });
    const at = Date.now();
    await button.click();
    return at;
  };
  const backendIs = (state: string) => async () =>
    (await snapshot(container.id)).remote?.state === state;
  // The strip must agree with the backend at every step.
  const agrees = async () => {
    const state = await snapshot(container.id);
    return (await strip(page)) === expectedStrip(state.remote);
  };

  const originUrl = inContainer(containerId, "git remote get-url origin").trim();
  const advance = await mkdtemp(path.join(os.tmpdir(), "ork-remote-advance-"));
  let urlBroken = false;
  await page.setViewportSize({ width: 1400, height: 900 });
  await login(page, testInfo);
  try {
    await selectEnvironment(page, containerName);
    await openChanges(page);
    await expect.poll(agrees, { timeout: 30_000 }).toBe(true);
    await record("opened");

    // 1. A good fetch: the base is current and no strip shows.
    await page.waitForTimeout(EXPLICIT_MIN_INTERVAL_MS);
    let at = await refreshAt();
    const currentMs = await msUntil(at, backendIs("current"), "current");
    await expect.poll(agrees, { timeout: 10_000 }).toBe(true);
    await record("refreshed", { backendMs: currentMs });
    expect(await strip(page)).toBeNull();

    // 2. The remote moves. Nothing can know until a fetch; no strip is right.
    // The project's own origin: a profile restarted without `--fixture`
    // reports no `testProject`, but the project record keeps its URL.
    const project = await invoke<{ gitUrl: string }>("get_project", {
      projectId: container.projectId,
    });
    git(advance, "clone", "--quiet", project.gitUrl, "checkout");
    const checkout = path.join(advance, "checkout");
    git(checkout, "config", "user.email", "remote-freshness@example.invalid");
    git(checkout, "config", "user.name", "remote-freshness");
    git(checkout, "checkout", "--quiet", branch);
    await writeFile(path.join(checkout, remoteFile), "advanced\n");
    git(checkout, "add", remoteFile);
    git(checkout, "commit", "--quiet", "-m", "advance the remote");
    git(checkout, "push", "--quiet", "origin", `HEAD:${branch}`);
    await page.waitForTimeout(5_000);
    await record("remote advanced, not fetched");
    expect(await strip(page)).toBeNull();

    // 3. A remote read fails: the strip says the base may be behind.
    inContainer(containerId, `git remote set-url origin /nonexistent/qa-origin-${run}.git`);
    urlBroken = true;
    await page.waitForTimeout(EXPLICIT_MIN_INTERVAL_MS);
    at = await refreshAt();
    const staleMs = await msUntil(at, backendIs("stale"), "stale");
    const staleStripMs = await msUntil(
      at,
      async () => (await strip(page)) === "remote-stale",
      "strip",
    );
    const staleStep = await record("fetch failed", { backendMs: staleMs, stripMs: staleStripMs });
    expect(staleStep.failure).not.toBeNull();
    const detail = await page
      .locator('[role="status"][data-freshness="remote-stale"]')
      .textContent();
    expect(detail).toContain("Base may be behind remote");

    // 4. Another failure while the page shows another environment.
    await selectEnvironment(page, localName);
    await expect.poll(() => strip(page), { timeout: 15_000 }).toBeNull();
    await page.waitForTimeout(EXPLICIT_MIN_INTERVAL_MS);
    await invoke("get_git_status", { containerId, targetBranch: comparisonRef, refresh: true });
    await page.waitForTimeout(5_000);
    const returned = Date.now();
    await selectEnvironment(page, containerName);
    await openChanges(page);
    const returnMs = await msUntil(
      returned,
      async () => (await strip(page)) === "remote-stale",
      "return",
    );
    await record("returned after a failure while away", { stripMs: returnMs });

    // 5. A reload rehydrates the same state from the backend.
    await reloadApp(page, testInfo);
    await selectEnvironment(page, containerName);
    await openChanges(page);
    const reloaded = Date.now();
    const reloadMs = await msUntil(
      reloaded,
      async () => (await strip(page)) === "remote-stale",
      "reload",
    );
    await record("reloaded", { stripMs: reloadMs });

    // 6. Remote reads work again: a refresh fetches the moved base, the strip
    // clears, and the list now compares with the advanced remote.
    inContainer(containerId, `git remote set-url origin '${originUrl.replaceAll("'", "'\\''")}'`);
    urlBroken = false;
    await page.waitForTimeout(EXPLICIT_MIN_INTERVAL_MS);
    at = await refreshAt();
    const recoveredMs = await msUntil(at, backendIs("current"), "recovered");
    const clearedMs = await msUntil(at, async () => (await strip(page)) === null, "cleared");
    const listMs = await msUntil(
      at,
      async () =>
        page
          .evaluate((name) => Boolean(document.querySelector(`[title*="${name}"]`)), remoteFile)
          .catch(() => false),
      "advanced base in the list",
    );
    await record("recovered", { backendMs: recoveredMs, stripMs: clearedMs, listMs });
  } finally {
    if (urlBroken) {
      inContainer(containerId, `git remote set-url origin '${originUrl.replaceAll("'", "'\\''")}'`);
    }
    await rm(advance, { recursive: true, force: true });
    testInfo.annotations.push({ type: "remote freshness", description: JSON.stringify(steps) });
  }
  for (const step of steps) {
    const remote =
      step.backend === "absent"
        ? undefined
        : { state: step.backend as WorktreeRemoteFreshnessState };
    expect(step.strip, String(step.step)).toBe(expectedStrip(remote));
  }
});
