/**
 * Change-to-visible latency as a browser client sees it (todo 0048 tasks 2
 * and 7, docs/todo/transcripts-and-observation/0048-recurring-work-qualification.md),
 * against a credential-free profile started with
 * `--fixture --fixture-environments local,container`:
 *
 *   ORKESTRATOR_HOST_REACHABILITY_CHECK=off mise run dev:test --profile q48mac --fixture \
 *     --fixture-environments local,container --no-agent-credentials --agent-platforms pi
 *   ORKESTRATOR_AGENT_TEST_PROFILE=q48mac ORKESTRATOR_AGENT_TEST_LATENCY_PROBES=1 \
 *     mise run test:logged -- --name change-to-visible -- \
 *     bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts \
 *     change-to-visible-latency.spec.ts --workers=1
 *
 * Each probe writes a file the way a user or agent would (straight into the
 * local worktree, or `docker exec` into the container) and times, in this
 * process, until the page shows it: the sidebar change badge, a Changes row
 * and an All files entry, each against its budget in
 * docs/architecture/recurring-work.md ("Latency budgets"). Container probes
 * start at random offsets, so they do not phase-lock to the 15 s scan.
 *
 * Two task 7 cases follow on the watched local worktree: bursts of thousands
 * of files (the watcher's overflow path) and the loss of the backend's watch
 * helper (its fall back to polling and the retry). The helper is signalled
 * only after its parent is proved to be this profile's backend.
 *
 * Results are annotations and `evidence-change-to-visible.json` beside the
 * run: milliseconds and counts only. File names are generated; no repository
 * content, token or transcript reaches output.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "./browser-test";
import {
  assertLatencyBudgets,
  latencySummary as summary,
  type LatencySeries,
} from "./latency-budget";
import {
  containerName,
  fixtureEnvironment,
  inContainer,
  invoke,
  localName,
  login,
  profileStatus,
  selectEnvironment,
} from "./container-wiring-support";

const LIVE = process.env.ORKESTRATOR_AGENT_TEST_LATENCY_PROBES === "1";
const PROBES = Math.max(3, Number(process.env.ORKESTRATOR_AGENT_TEST_LATENCY_PROBE_COUNT ?? "15"));
const BURSTS = (process.env.ORKESTRATOR_AGENT_TEST_LATENCY_BURSTS ?? "2000,5000,20000")
  .split(",")
  .map(Number)
  .filter((value) => value > 0);
/**
 * docs/architecture/recurring-work.md, "Latency budgets" (p95). Every probe is
 * timed from its write; the watched budget runs from when the save settles
 * (`WATCH_SETTLE_MS`, 400 ms), so its bound here includes the settle.
 */
const WATCH_SETTLE_MS = 400;
const BUDGET = {
  watchedDiffMs: 2_000 + WATCH_SETTLE_MS,
  unwatchedDiffMs: 20_000,
  filesPanelMs: 6_000,
  explicitActionMs: 1_000,
} as const;
/** The container scan interval the random offsets spread across. */
const CONTAINER_SCAN_MS = 15_000;

test.describe.configure({ mode: "serial" });
// The direct invoke carries the gateway token; keep it out of artifacts.
test.use({ trace: "off", screenshot: "off", video: "off" });
test.skip(!LIVE, "Set ORKESTRATOR_AGENT_TEST_LATENCY_PROBES=1 against a disposable profile");

// One line a minute, so `test:logged`'s no-output watchdog (5 min) does not
// end a long, quiet probe loop. No content, only the test's title.
let progress: ReturnType<typeof setInterval> | undefined;
test.beforeEach(() => {
  const { title } = test.info();
  progress = setInterval(() => console.log(`still running: ${title}`), 60_000);
});
test.afterEach(() => clearInterval(progress));

const evidence: { series: LatencySeries[]; notes: Record<string, unknown> } = {
  series: [],
  notes: {},
};

function seriesFor(label: string, budgetMs?: number, scanAllowance = false): LatencySeries {
  let series = evidence.series.find((entry) => entry.label === label);
  if (!series) {
    series = { label, budgetMs, ...(scanAllowance ? { scanAllowance } : {}), samples: [] };
    evidence.series.push(series);
  }
  return series;
}

test.afterAll(async () => {
  if (!LIVE) return;
  const status = profileStatus() as { browserUrl?: string };
  const out = path.join(
    path.resolve(import.meta.dirname, "../.."),
    "output",
    "agent-testing",
    process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ??
      process.env.ORKESTRATOR_AGENT_TEST_PROFILE ??
      "q48mac",
    "evidence-change-to-visible.json",
  );
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(
    out,
    `${JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        platform: process.platform,
        profileReady: Boolean(status.browserUrl),
        series: evidence.series.map(summary),
        notes: evidence.notes,
      },
      null,
      2,
    )}\n`,
  );
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Milliseconds from `since` until `done` first holds; throws after `timeoutMs`. */
async function msUntil(
  since: number,
  done: () => Promise<boolean>,
  label: string,
  timeoutMs = 60_000,
): Promise<number> {
  const deadline = since + timeoutMs;
  for (;;) {
    if (await done()) return Date.now() - since;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(25);
  }
}

/**
 * Untracked files the backend line-counts per scan (`UNTRACKED_SCAN_MAX_FILES`,
 * apps/backend/src/core/commands-validation.ts). Past it the badge is
 * approximate and its tooltip names the cap, so a bigger burst can never show
 * an exact `+N`.
 */
const UNTRACKED_SCAN_MAX_FILES = 2_000;
const CAPPED_REASON = "Too many untracked files to count them all";

/** The environment's sidebar badge: its `+N` additions and whether the count is capped. */
async function badgeState(
  page: Page,
  environmentName: string,
): Promise<{ additions: number | null; capped: boolean }> {
  const badge = await page
    .evaluate((name) => {
      for (const label of Array.from(document.querySelectorAll("span[id]"))) {
        if (label.textContent !== name) continue;
        const element = label
          .closest('[role="button"]')
          ?.querySelector<HTMLElement>(
            '[data-testid="environment-change-badge"], [data-testid="environment-diff-stats"]',
          );
        if (element) return { text: element.textContent, title: element.title };
      }
      return null;
    }, environmentName)
    .catch(() => null);
  const match = /\+([\d,]+)/.exec(badge?.text ?? "");
  return {
    additions: match ? Number(match[1]!.replaceAll(",", "")) : null,
    capped: Boolean(badge?.title.includes(CAPPED_REASON)),
  };
}

/** The `+N` additions the environment's sidebar badge shows, or null. */
async function badgeAdditions(page: Page, environmentName: string): Promise<number | null> {
  return (await badgeState(page, environmentName)).additions;
}

/** Whether any element of the page is titled by (or names) this generated file. */
async function shown(page: Page, file: string): Promise<boolean> {
  return page
    .evaluate((name) => {
      if (document.querySelector(`[title*="${name}"]`)) return true;
      for (const node of Array.from(document.querySelectorAll("span, div, button"))) {
        if (node.childElementCount === 0 && node.textContent === name) return true;
      }
      return false;
    }, file)
    .catch(() => false);
}

async function filesPanel(page: Page, tab: "changes" | "all") {
  const show = page.getByRole("button", { name: "Show file panel" });
  const hide = page.getByRole("button", { name: "Hide file panel" });
  await expect(show.or(hide)).toBeVisible({ timeout: 30_000 });
  if (await show.isVisible()) await show.click();
  await expect(hide).toBeVisible();
  if (tab === "changes") await page.getByRole("tab", { name: /^Changes/ }).click();
  else await page.getByRole("tab", { name: "All files", exact: true }).click();
}

async function closeFilesPanel(page: Page) {
  const hide = page.getByRole("button", { name: "Hide file panel" });
  if (await hide.isVisible()) await hide.click();
}

/** Recurring diagnostics' `worktree-snapshots` gauges (counts only). */
async function snapshotGauges(): Promise<Record<string, number>> {
  const diagnostics = await invoke<{
    caches: Array<{ name: string; gauges: Record<string, number> }>;
  }>("get_recurring_work_diagnostics");
  return diagnostics.caches.find((entry) => entry.name === "worktree-snapshots")?.gauges ?? {};
}

function lines(count: number, tag: string): string {
  return Array.from({ length: count }, (_, index) => `${tag} ${index}`).join("\n") + "\n";
}

test("watched local worktree: badge, Changes row and All files entry", async ({
  page,
}, testInfo) => {
  test.setTimeout(15 * 60_000);
  const local = await fixtureEnvironment(localName);
  const worktree = local.worktreePath;
  if (!worktree) throw new Error(`${localName} has no worktree`);
  const run = randomUUID().slice(0, 6);
  const written: string[] = [];
  await page.setViewportSize({ width: 1400, height: 900 });
  await login(page, testInfo);
  await selectEnvironment(page, localName);
  try {
    for (const tab of ["changes", "all"] as const) {
      await filesPanel(page, tab);
      for (let probe = 0; probe < PROBES; probe += 1) {
        // Names sort first, so a virtualised list renders them.
        const file = `0-ctv-${run}-${tab}-${probe}.txt`;
        written.push(file);
        const before = (await badgeAdditions(page, localName)) ?? 0;
        await sleep(500 + Math.floor(Math.random() * 1_500));
        const at = Date.now();
        await fs.writeFile(path.join(worktree, file), lines(3, "probe"));
        const panel = msUntil(at, () => shown(page, file), `${tab} entry ${probe}`);
        const badge = msUntil(
          at,
          async () => (await badgeAdditions(page, localName)) === before + 3,
          `badge ${probe}`,
        );
        const [panelMs, badgeMs] = await Promise.all([panel, badge]);
        seriesFor("local badge (watched)", BUDGET.watchedDiffMs).samples.push(badgeMs);
        seriesFor(
          tab === "changes" ? "local Changes row" : "local All files entry",
          BUDGET.filesPanelMs,
        ).samples.push(panelMs);
      }
    }
  } finally {
    await Promise.all(written.map((file) => fs.rm(path.join(worktree, file), { force: true })));
  }
  for (const series of evidence.series.filter((entry) => entry.label.startsWith("local"))) {
    testInfo.annotations.push({ type: series.label, description: JSON.stringify(summary(series)) });
  }
  assertLatencyBudgets(evidence.series.filter((entry) => entry.label.startsWith("local")));
});

test("container: badge, Changes row, All files entry and explicit refresh", async ({
  page,
}, testInfo) => {
  test.skip(process.env.ORKESTRATOR_AGENT_TEST_DOCKER !== "1", "Docker fixture profile required");
  test.setTimeout(30 * 60_000);
  const container = await fixtureEnvironment(containerName);
  const containerId = container.containerId;
  if (!containerId) throw new Error(`${containerName} has no container`);
  const run = randomUUID().slice(0, 6);
  const written: string[] = [];
  await page.setViewportSize({ width: 1400, height: 900 });
  await login(page, testInfo);
  await selectEnvironment(page, containerName);
  try {
    for (const tab of ["changes", "all"] as const) {
      await filesPanel(page, tab);
      for (let probe = 0; probe < PROBES; probe += 1) {
        const file = `0-ctv-${run}-${tab}-${probe}.txt`;
        written.push(file);
        const before = (await badgeAdditions(page, containerName)) ?? 0;
        // A random point in the scan interval, so probes sample its phase.
        await sleep(Math.floor(Math.random() * CONTAINER_SCAN_MS));
        const at = Date.now();
        inContainer(containerId, `printf 'a\\nb\\nc\\n' > ${file}`);
        const panel = msUntil(at, () => shown(page, file), `${tab} entry ${probe}`, 90_000);
        const badge = msUntil(
          at,
          async () => (await badgeAdditions(page, containerName)) === before + 3,
          `badge ${probe}`,
          90_000,
        );
        const [panelMs, badgeMs] = await Promise.all([panel, badge]);
        seriesFor("container badge", BUDGET.unwatchedDiffMs).samples.push(badgeMs);
        seriesFor(
          tab === "changes" ? "container Changes row" : "container All files entry",
          BUDGET.filesPanelMs,
        ).samples.push(panelMs);
      }
    }

    // Explicit refresh: the write, then at once the panel's Refresh.
    for (const tab of ["changes", "all"] as const) {
      await filesPanel(page, tab);
      for (let probe = 0; probe < PROBES; probe += 1) {
        const file = `0-ctv-${run}-refresh-${tab}-${probe}.txt`;
        written.push(file);
        await sleep(Math.floor(Math.random() * CONTAINER_SCAN_MS));
        inContainer(containerId, `printf 'r\\n' > ${file}`);
        const refresh = page.getByRole("button", { name: "Refresh", exact: true });
        await expect(refresh).toBeEnabled({ timeout: 30_000 });
        const at = Date.now();
        await refresh.click();
        seriesFor(
          tab === "changes"
            ? "container Changes after Refresh"
            : "container All files after Refresh",
          BUDGET.explicitActionMs,
          // The Changes refresh follows a scan already running (to-do 7201):
          // its accepted budget is one scan longer. All files reads directly.
          tab === "changes",
        ).samples.push(
          await msUntil(at, () => shown(page, file), `refresh ${tab} ${probe}`, 90_000),
        );
      }
    }
  } finally {
    if (written.length > 0) inContainer(containerId, `rm -f ${written.join(" ")}; true`);
  }
  for (const series of evidence.series.filter((entry) => entry.label.startsWith("container"))) {
    testInfo.annotations.push({ type: series.label, description: JSON.stringify(summary(series)) });
  }
  assertLatencyBudgets(evidence.series.filter((entry) => entry.label.startsWith("container")));
});

test("watched local worktree: bursts past the watcher's overflow reach the badge", async ({
  page,
}, testInfo) => {
  test.setTimeout(20 * 60_000);
  const local = await fixtureEnvironment(localName);
  const worktree = local.worktreePath!;
  const run = randomUUID().slice(0, 6);
  const directory = path.join(worktree, `0-ctv-burst-${run}`);
  await page.setViewportSize({ width: 1400, height: 900 });
  await login(page, testInfo);
  await selectEnvironment(page, localName);
  await closeFilesPanel(page);
  const bursts: Array<Record<string, unknown>> = [];
  try {
    // Each burst is removed before the next, so every one starts from the
    // same exact count. Past the scan cap the badge cannot show `+files`, so
    // "shown" is the first capped badge; the removal back to the exact
    // earlier count is what proves no final change was lost.
    for (const files of BURSTS) {
      const before = (await badgeAdditions(page, localName)) ?? 0;
      const capped = files > UNTRACKED_SCAN_MAX_FILES;
      const started = Date.now();
      const perDirectory = 500;
      for (let start = 0; start < files; start += perDirectory) {
        await fs.mkdir(path.join(directory, `b${start}`), { recursive: true });
      }
      for (let start = 0; start < files; start += 256) {
        await Promise.all(
          Array.from({ length: Math.min(256, files - start) }, (_, offset) => {
            const index = start + offset;
            return fs.writeFile(
              path.join(
                directory,
                `b${Math.floor(index / perDirectory) * perDirectory}`,
                `f${index}.txt`,
              ),
              "x\n",
            );
          }),
        );
      }
      const lastWrite = Date.now();
      let shownMs: number | null = null;
      try {
        shownMs = await msUntil(
          lastWrite,
          async () => {
            const badge = await badgeState(page, localName);
            return capped ? badge.capped : badge.additions === before + files;
          },
          `burst of ${files}`,
          180_000,
        );
      } catch {
        shownMs = null;
      }
      const shown = await badgeState(page, localName);
      const removedAt = Date.now();
      await fs.rm(directory, { recursive: true, force: true });
      let clearedMs: number | null = null;
      try {
        clearedMs = await msUntil(
          removedAt,
          async () => {
            const badge = await badgeState(page, localName);
            return !badge.capped && (badge.additions ?? 0) === before;
          },
          `removal of ${files}`,
          180_000,
        );
      } catch {
        clearedMs = null;
      }
      const result = {
        files,
        capped,
        writeMs: lastWrite - started,
        badgeAfterLastWriteMs: shownMs,
        badgeAdditions: shown.additions,
        badgeCapped: shown.capped,
        expectedAdditions: capped ? null : before + files,
        exactAfterRemovalMs: clearedMs,
      };
      bursts.push(result);
      testInfo.annotations.push({ type: `burst ${files}`, description: JSON.stringify(result) });
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
  evidence.notes.bursts = bursts;
  for (const burst of bursts) {
    expect(
      burst.badgeAfterLastWriteMs,
      `burst ${burst.files} never reached the badge`,
    ).not.toBeNull();
    expect(
      burst.exactAfterRemovalMs,
      `the badge never returned to its count after burst ${burst.files}`,
    ).not.toBeNull();
  }
});

function watchHelperOf(backendPid: number): { pid: number; started: string } | null {
  const listing = spawnSync("ps", ["-ww", "-A", "-o", "pid=,ppid=,lstart=,command="], {
    encoding: "utf8",
  }).stdout;
  for (const line of listing.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(line);
    if (!match || Number(match[2]) !== backendPid) continue;
    // The helper is `bun -e` running watch-host.ts's program.
    if (!/\bbun -e\b/.test(match[4]!) || !match[4]!.includes('require("node:fs")')) continue;
    return { pid: Number(match[1]), started: match[3]! };
  }
  return null;
}

test("watched local worktree: a lost watch helper falls back to polling and re-attaches", async ({
  page,
}, testInfo) => {
  test.skip(process.platform !== "darwin", "The watch helper exists on macOS only");
  test.setTimeout(15 * 60_000);
  const local = await fixtureEnvironment(localName);
  const worktree = local.worktreePath!;
  const run = randomUUID().slice(0, 6);
  const written: string[] = [];
  await page.setViewportSize({ width: 1400, height: 900 });
  await login(page, testInfo);
  await selectEnvironment(page, localName);
  const save = async (label: string, timeoutMs: number) => {
    const file = `0-ctv-${run}-${label}.txt`;
    written.push(file);
    const before = (await badgeAdditions(page, localName)) ?? 0;
    const at = Date.now();
    await fs.writeFile(path.join(worktree, file), lines(2, label));
    return msUntil(
      at,
      async () => (await badgeAdditions(page, localName)) === before + 2,
      label,
      timeoutMs,
    );
  };
  try {
    const backendPid = (profileStatus() as { pids?: { backend?: number } }).pids?.backend;
    if (!backendPid) throw new Error("dev:status names no backend pid");
    const helper = watchHelperOf(backendPid);
    if (!helper) throw new Error("no watch helper under this profile's backend");
    const watchedBefore = (await snapshotGauges()).watched ?? 0;
    expect(watchedBefore).toBeGreaterThan(0);
    const beforeMs = await save("before-loss", 10_000);

    // Same pid, same start time, same parent: it is still the helper we found.
    const again = watchHelperOf(backendPid);
    expect(again).toEqual(helper);
    const killedAt = Date.now();
    process.kill(helper.pid, "SIGKILL");
    const fallbackMs = await msUntil(
      killedAt,
      async () => ((await snapshotGauges()).watched ?? 0) < watchedBefore,
      "watched gauge drop",
      30_000,
    );
    const afterLoss = await snapshotGauges();
    // Polling: a save is still shown, inside the unwatched budget.
    const pollingSaves: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      await sleep(Math.floor(Math.random() * 5_000));
      pollingSaves.push(await save(`polling-${index}`, 60_000));
      if (((await snapshotGauges()).watched ?? 0) >= watchedBefore) break;
    }
    // The retry (30 s base backoff) re-attaches, spawning a new helper.
    const reattachMs = await msUntil(
      killedAt,
      async () => ((await snapshotGauges()).watched ?? 0) >= watchedBefore,
      "re-attach",
      5 * 60_000,
    );
    const replacement = watchHelperOf(backendPid);
    const afterMs = await save("after-retry", 10_000);
    const result = {
      watchedBefore,
      saveBeforeLossMs: beforeMs,
      fallbackDetectedMs: fallbackMs,
      watchedAfterLoss: afterLoss.watched ?? 0,
      retryTimersAfterLoss: afterLoss.retryTimers ?? 0,
      pollingSavesMs: pollingSaves,
      reattachAfterLossMs: reattachMs,
      newHelper: replacement !== null && replacement.pid !== helper.pid,
      saveAfterRetryMs: afterMs,
    };
    evidence.notes.helperLoss = result;
    testInfo.annotations.push({ type: "helper loss", description: JSON.stringify(result) });
    expect(result.newHelper).toBe(true);
    for (const ms of pollingSaves) expect(ms).toBeLessThanOrEqual(BUDGET.unwatchedDiffMs);
    expect(afterMs).toBeLessThanOrEqual(BUDGET.watchedDiffMs);
  } finally {
    await Promise.all(written.map((file) => fs.rm(path.join(worktree, file), { force: true })));
  }
});
