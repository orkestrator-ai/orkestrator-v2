/**
 * Reconnect timing in a real background tab (todo 0048 task 18,
 * docs/todo/transcripts-and-observation/0048-recurring-work-qualification.md).
 *
 * Headless Chromium keeps every page `visible`, and a browser Playwright
 * launches never hides a page either: its default switches turn background
 * throttling off and it enables DevTools focus emulation on every page, which
 * keeps the tab visible. So neither the busy profile nor `client-outage.spec.ts`
 * ever measured a hidden tab. This spec starts headed Chromium itself, with
 * none of those switches, and attaches over CDP with `noDefaults`, so the
 * default context's pages are hidden whenever the browser decides they are.
 * It opens the real app on a credential-free `dev:test` profile through a
 * link this test can break (`client-outage-support.ts`; the machine's
 * network is untouched), lets the browser hide the tab (by occlusion, behind
 * another tab of the same window, or minimised, whichever happens first),
 * and checks:
 *
 * 1. the browser really throttles the hidden tab's timers;
 * 2. a link that drops and comes back while the tab is hidden is reconnected
 *    by the hidden tab on its own (main stream and terminal stream), within
 *    the event ladder's cap plus the throttling's alignment;
 * 3. a tab made visible while its streams wait out a long backoff retries
 *    them at once, rather than at the ladder's next rung
 *    (`retryWaitingStreams` in `apps/web/src/lib/native/node-transport.ts`).
 *
 * Setup and the "shown" step turn this test's own focus emulation on, which
 * makes the browser show the page exactly as it does for a captured tab (a
 * real `visibilitychange`, timers unthrottled). Bringing the tab to the
 * front does the same on an unlocked display; a locked one occludes every
 * window, so only emulation can show it there. The evidence names the
 * mechanism (`hiddenBy`, `shownBy`).
 *
 * Opt-in (`ORKESTRATOR_AGENT_TEST_LIVE_BACKGROUND_TAB=1`) and needs a display:
 * a headed window opens for a few minutes. Run it alone against a
 * credential-free profile of its own:
 *
 *   ORKESTRATOR_HOST_REACHABILITY_CHECK=off mise run dev:test --profile q48t18 \
 *     --fixture --no-agent-credentials --no-host-seed --agent-platforms pi --headless
 *   ORKESTRATOR_AGENT_TEST_PROFILE=q48t18 ORKESTRATOR_AGENT_TEST_LIVE_BACKGROUND_TAB=1 \
 *     mise run test:logged -- --name background-tab -- \
 *     bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts \
 *     background-tab-reconnect-live.spec.ts --workers=1
 *
 * Evidence is timings, kinds and counts only (`evidence-*.json` beside the
 * run and an annotation); no token, terminal content or URL query is kept.
 */
// Not `./browser-test`: this case needs a browser Playwright did not launch.
import {
  chromium,
  expect,
  test,
  type Browser,
  type CDPSession,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { fetchModulesOutsideChromium } from "./browser-test";
import { startOutageLink, type LinkRequestKind, type OutageLink } from "./client-outage-support";

type Status = {
  status: string;
  browserUrl?: string;
  rendererUrl?: string;
  testProject?: string;
  authFile?: string;
};
type Project = { id: string; localPath: string | null; name: string };
type Environment = { id: string; name: string };
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "q48t18";
const LIVE = process.env.ORKESTRATOR_AGENT_TEST_LIVE_BACKGROUND_TAB === "1";
const HAS_DISPLAY =
  process.platform === "darwin" ||
  process.platform === "win32" ||
  Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
/** Long enough to climb the event ladder (2, 4, 8, 16 s) to its cap. */
const OUTAGE_MS = Number(process.env.ORKESTRATOR_AGENT_TEST_OUTAGE_MS ?? 45_000);
const EVENT_RECONNECT_CAP_MS = 16_000;
/** Chromium wakes a hidden page's timers once a second, so add a rung of slack. */
const HIDDEN_RECONNECT_BUDGET_MS = EVENT_RECONNECT_CAP_MS + 4_000;
/** A visible tab retries at once: one event-loop turn plus a request. */
const VISIBLE_RETRY_BUDGET_MS = 1_000;
/** Equal jitter at the cap: the next rung is at least this far after a failure. */
const CAP_RUNG_FLOOR_MS = EVENT_RECONNECT_CAP_MS / 2;
const NETWORK_RESEND_MS = 100;
const PROBE_TICK_MS = 100;

test.skip(!LIVE, "Set ORKESTRATOR_AGENT_TEST_LIVE_BACKGROUND_TAB=1 against a disposable profile");
test.skip(!HAS_DISPLAY, "Needs a display: a headless page is never really backgrounded");
test.use({ trace: "off", screenshot: "off", video: "off" });

/**
 * Playwright's quiet-startup switches, minus the three that stop a background
 * tab being one (`--disable-background-timer-throttling`,
 * `--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding`).
 * `--use-mock-keychain` and `--password-store=basic` keep the browser away
 * from the login keychain.
 */
const CHROME_SWITCHES = [
  "--remote-debugging-port=0",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--disable-breakpad",
  "--disable-component-extensions-with-background-pages",
  "--disable-component-update",
  "--disable-default-apps",
  "--disable-extensions",
  "--disable-sync",
  "--metrics-recording-only",
  "--password-store=basic",
  "--use-mock-keychain",
  "--window-position=0,0",
  "--window-size=1280,860",
];

/** A headed Chromium this test started, attached without Playwright's page overrides. */
async function startChrome(
  userDataDir: string,
): Promise<{ browser: Browser; child: ChildProcess }> {
  const child = spawn(
    chromium.executablePath(),
    [...CHROME_SWITCHES, `--user-data-dir=${userDataDir}`, "about:blank"],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const endpoint = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error("Chromium printed no DevTools endpoint")),
      30_000,
    );
    child.once("exit", () => reject(new Error("Chromium exited before it was ready")));
    child.stderr!.on("data", (chunk: Buffer) => {
      // Bounded: only the first lines carry the endpoint.
      if (output.length < 64 * 1024) output += chunk.toString("utf8");
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]!);
      }
    });
  });
  child.stderr!.resume();
  const browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
  return { browser, child };
}

async function stopChrome(chrome: { browser: Browser; child: ChildProcess } | null): Promise<void> {
  if (!chrome) return;
  await chrome.browser.close().catch(() => undefined);
  if (chrome.child.exitCode === null && chrome.child.signalCode === null) {
    const exited = new Promise((resolve) => chrome.child.once("exit", resolve));
    // Only the process this test spawned, through its own handle.
    chrome.child.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  }
}

function profileStatus(): Status {
  const command = spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (!command.stdout.trim()) throw new Error(command.stderr || "dev:status returned no manifest");
  return JSON.parse(command.stdout) as Status;
}

/** Setup reaches the gateway directly, so no outage ever touches it. */
function directInvoke(status: Status): Invoke {
  const url = new URL("/__orkestrator/invoke", status.browserUrl!).href;
  const token = (JSON.parse(readFileSync(status.authFile!, "utf8")) as { token: string }).token;
  return async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ command, args }),
    });
    if (!response.ok) throw new Error(`${command} failed with HTTP ${response.status}`);
    return ((await response.json()) as { result: T }).result;
  };
}

function mintLoginPath(): string {
  const command = spawnSync("mise", ["run", "dev:login", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (command.status !== 0) throw new Error(command.stderr || "dev:login failed");
  const login = JSON.parse(command.stdout) as { loginUrl?: unknown };
  if (typeof login.loginUrl !== "string") throw new Error("dev:login returned no login URL");
  const url = new URL(login.loginUrl);
  return `${url.pathname}${url.search}`;
}

async function createEnvironment(invoke: Invoke, fixture: Project): Promise<Environment> {
  const environment = await invoke<Environment>("create_environment", {
    projectId: fixture.id,
    name: `bg-tab-${Date.now()}`,
    networkAccessMode: "restricted",
    environmentType: "local",
  });
  await invoke("start_environment", { environmentId: environment.id });
  const layout = await invoke<{ revision?: number } | null>("get_pane_layout", {
    environmentId: environment.id,
  });
  await invoke("save_pane_layout", {
    environmentId: environment.id,
    expectedRevision: layout?.revision ?? 0,
    layout: {
      version: PANE_LAYOUT_VERSION,
      containerId: null,
      activePaneId: "pane-first",
      root: {
        kind: "leaf",
        id: "pane-first",
        activeTabId: "tab-first",
        tabs: [{ id: "tab-first", type: "plain" }],
      },
    },
  });
  return environment;
}

type ProbeSnapshot = {
  visibility: Array<{ at: number; state: string }>;
  /** Wall-clock times of a 100 ms interval's callbacks, bounded. */
  ticks: number[];
};

declare global {
  interface Window {
    backgroundTabProbe: { snapshot(): ProbeSnapshot };
  }
}

/** Visibility changes and timer wake-ups in the page; nothing else. */
async function installProbe(page: Page): Promise<void> {
  await page.addInitScript((tickMs: number) => {
    localStorage.setItem("orkestrator-terminal-transport", "http-sse");
    const visibility: ProbeSnapshot["visibility"] = [
      { at: Date.now(), state: document.visibilityState },
    ];
    const ticks: number[] = [];
    document.addEventListener("visibilitychange", () => {
      visibility.push({ at: Date.now(), state: document.visibilityState });
    });
    setInterval(() => {
      ticks.push(Date.now());
      if (ticks.length > 20_000) ticks.splice(0, 10_000);
    }, tickMs);
    window.backgroundTabProbe = { snapshot: () => ({ visibility, ticks }) };
  }, PROBE_TICK_MS);
}

const snapshotOf = (page: Page) => page.evaluate(() => window.backgroundTabProbe.snapshot());

const attempts = (link: OutageLink, kind: LinkRequestKind, since: number, until = Infinity) =>
  link.requests
    .filter((request) => request.kind === kind && request.at >= since && request.at < until)
    .map((request) => request.at)
    // Chromium silently resends a request that died on a reused idle socket.
    .filter((at, index, times) => index === 0 || at - times[index - 1]! > NETWORK_RESEND_MS);

const firstAnswered = (link: OutageLink, kind: LinkRequestKind, since: number): number | null =>
  link.requests.find(
    (request) =>
      request.kind === kind &&
      request.at >= since &&
      request.answeredAt !== undefined &&
      request.status !== undefined &&
      request.status < 400,
  )?.answeredAt ?? null;

const firstAttempt = (link: OutageLink, kind: LinkRequestKind, since: number): number | null =>
  link.requests.find((request) => request.kind === kind && request.at >= since)?.at ?? null;

const gapsOf = (times: readonly number[]) => times.slice(1).map((at, index) => at - times[index]!);

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
}

function writeEvidence(testInfo: TestInfo, name: string, evidence: unknown): void {
  const body = JSON.stringify(evidence, null, 2);
  writeFileSync(testInfo.outputPath(`${name}.json`), `${body}\n`);
  testInfo.annotations.push({ type: name, description: body });
  console.log(`[background-tab] ${name} ${JSON.stringify(evidence)}`);
}

const visibilityOf = (page: Page) => page.evaluate(() => document.visibilityState);

/** This test's own focus emulation: on shows the page as a captured tab, off hands it back. */
async function emulateShown(session: CDPSession, shown: boolean): Promise<void> {
  await session.send("Emulation.setFocusEmulationEnabled", { enabled: shown });
}

const becomes = (page: Page, state: string, timeout: number) =>
  expect
    .poll(() => visibilityOf(page), { timeout })
    .toBe(state)
    .then(() => true)
    .catch(() => false);

/**
 * Hands the page back to the browser and lets it hide it: by occlusion (a
 * locked display, or another window over it), behind another tab, or
 * minimised, whichever happens first.
 */
async function hide(
  page: Page,
  session: CDPSession,
  openCover: () => Promise<Page>,
): Promise<string> {
  await emulateShown(session, false);
  if (await becomes(page, "hidden", 3_000)) return "occluded";
  const cover = await openCover();
  await cover.bringToFront();
  if (await becomes(page, "hidden", 5_000)) return "behind-another-tab";
  const { windowId } = (await session.send("Browser.getWindowForTarget")) as { windowId: number };
  await session.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } });
  if (await becomes(page, "hidden", 5_000)) return "minimised";
  throw new Error("The browser never hid the tab: no occlusion, background tab or minimise");
}

async function show(page: Page, session: CDPSession): Promise<string> {
  const { windowId } = (await session.send("Browser.getWindowForTarget")) as { windowId: number };
  await session.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
  await page.bringToFront();
  const shown = await expect
    .poll(() => visibilityOf(page), { timeout: 1_000, intervals: [50] })
    .toBe("visible")
    .then(() => true)
    .catch(() => false);
  if (shown) return "brought-to-front";
  // A locked or sleeping display occludes every window.
  await emulateShown(session, true);
  await expect.poll(() => visibilityOf(page)).toBe("visible");
  return "focus-emulation";
}

// oxlint-disable-next-line no-empty-pattern -- Playwright reads fixture dependencies from this destructuring.
test("a background tab reconnects while hidden and retries at once when shown", async ({}, testInfo) => {
  test.setTimeout(2 * OUTAGE_MS + 240_000);
  const status = profileStatus();
  expect(status.status).toBe("ready");
  const invoke = directInvoke(status);
  const fixture = (await invoke<Project[]>("get_projects")).find(
    (project) => project.localPath === status.testProject,
  );
  if (!fixture) throw new Error("The fixture project is missing from this profile");
  const environment = await createEnvironment(invoke, fixture);
  const link = await startOutageLink({
    owner: "background-tab",
    gatewayUrl: status.browserUrl!,
    rendererUrl: status.rendererUrl!,
  });
  const userDataDir = testInfo.outputPath("chrome-profile");
  let chrome: Awaited<ReturnType<typeof startChrome>> | null = null;
  try {
    chrome = await startChrome(userDataDir);
    const context = chrome.browser.contexts()[0]!;
    await fetchModulesOutsideChromium(context);
    // The tab Chromium opened at launch: on a locked display it is the one
    // the browser occludes, while tabs opened over CDP stay visible there.
    const page = context.pages()[0] ?? (await context.newPage());
    page.setDefaultTimeout(20_000);
    const session = await context.newCDPSession(page);
    // Setup clicks need a rendering page, whatever the display is doing.
    await emulateShown(session, true);
    await installProbe(page);
    await page.route("**/__orkestrator/invoke", async (route) => {
      // The credential-free fixture exercises terminals, not login.
      let command: string | undefined;
      try {
        command = (route.request().postDataJSON() as { command?: string }).command;
      } catch {
        // Not a command.
      }
      if (command === "check_claude_cli") return route.fulfill({ json: { result: false } });
      return route.fallback();
    });
    await page.goto(new URL(mintLoginPath(), link.url).href, { waitUntil: "domcontentloaded" });
    const expand = page.getByRole("button", { name: `Expand project ${fixture.name}` });
    const entry = page.getByText(environment.name, { exact: true }).first();
    await expect(expand.or(entry)).toBeVisible({ timeout: 60_000 });
    if (await expand.isVisible()) await expand.click();
    await page.mouse.move(0, 0);
    await page.keyboard.press("Escape");
    await entry.click();
    await expect(page.locator(".xterm:visible")).toHaveCount(1, { timeout: 60_000 });
    await expect.poll(() => firstAnswered(link, "main-stream", 0) !== null).toBe(true);
    await expect.poll(() => firstAnswered(link, "terminal-stream", 0) !== null).toBe(true);

    // A few visible seconds, for the unthrottled tick baseline.
    await page.waitForTimeout(3_000);
    const hideStartedAt = Date.now();
    const hiddenBy = await hide(page, session, async () => {
      const cover = await context.newPage();
      await cover.goto(new URL("/__outage-link/blank", link.url).href);
      return cover;
    });
    const hiddenAt = Date.now();

    // 1. Throttling: a 100 ms interval in the hidden tab.
    await page.waitForTimeout(10_000);
    const visibleTicks = (await snapshotOf(page)).ticks.filter(
      (at) => at >= hideStartedAt - 2_500 && at < hideStartedAt,
    );
    const hiddenTicks = (await snapshotOf(page)).ticks.filter((at) => at >= hiddenAt + 1_000);
    const throttling = {
      hiddenBy,
      visibleTickP50Ms: percentile(gapsOf(visibleTicks), 0.5),
      hiddenTickP50Ms: percentile(gapsOf(hiddenTicks), 0.5),
      hiddenTickP95Ms: percentile(gapsOf(hiddenTicks), 0.95),
      hiddenTicks: hiddenTicks.length,
    };
    writeEvidence(testInfo, "evidence-throttling", throttling);
    expect(
      throttling.hiddenTickP50Ms,
      "the hidden tab's timers are throttled (Chromium wakes them once a second)",
    ).toBeGreaterThanOrEqual(900);

    // 2. A link that drops and returns while hidden.
    const firstOutageAt = Date.now();
    link.setMode("reset");
    await page.waitForTimeout(OUTAGE_MS);
    const firstRestoredAt = Date.now();
    link.setMode("up");
    await expect
      .poll(() => firstAnswered(link, "main-stream", firstRestoredAt), {
        timeout: HIDDEN_RECONNECT_BUDGET_MS + 10_000,
      })
      .not.toBeNull();
    await expect
      .poll(() => firstAnswered(link, "terminal-stream", firstRestoredAt), {
        timeout: HIDDEN_RECONNECT_BUDGET_MS + 10_000,
      })
      .not.toBeNull();
    const stillHidden = await visibilityOf(page);
    const mainHiddenAttempts = attempts(link, "main-stream", firstOutageAt, firstRestoredAt);
    const terminalHiddenAttempts = attempts(
      link,
      "terminal-stream",
      firstOutageAt,
      firstRestoredAt,
    );
    const visibilityHistory = (await snapshotOf(page)).visibility
      .filter((entry) => entry.at >= hideStartedAt - 1_000)
      .map((entry) => ({ state: entry.state, atMs: entry.at - hideStartedAt }));
    const hiddenReconnect = {
      visibilityHistory,
      outageStartedAtMs: firstOutageAt - hideStartedAt,
      restoredAtMs: firstRestoredAt - hideStartedAt,
      outageMs: firstRestoredAt - firstOutageAt,
      stateWhenBack: stillHidden,
      mainAttemptsDuringOutage: mainHiddenAttempts.length,
      mainAttemptGapsMs: gapsOf(mainHiddenAttempts),
      terminalAttemptsDuringOutage: terminalHiddenAttempts.length,
      terminalAttemptGapsMs: gapsOf(terminalHiddenAttempts),
      mainBackAfterRestoreMs:
        firstAnswered(link, "main-stream", firstRestoredAt)! - firstRestoredAt,
      terminalBackAfterRestoreMs:
        firstAnswered(link, "terminal-stream", firstRestoredAt)! - firstRestoredAt,
      budgetMs: HIDDEN_RECONNECT_BUDGET_MS,
    };
    writeEvidence(testInfo, "evidence-hidden-reconnect", hiddenReconnect);
    // Hidden from the hide to the reconnect: no visibility edge helped it.
    expect(stillHidden).toBe("hidden");
    expect(visibilityHistory.filter((entry) => entry.state === "visible")).toEqual([]);
    expect(hiddenReconnect.mainAttemptsDuringOutage).toBeGreaterThanOrEqual(3);
    // The ladder never runs faster than its first rung while hidden.
    expect(Math.min(...hiddenReconnect.mainAttemptGapsMs)).toBeGreaterThanOrEqual(900);
    expect(hiddenReconnect.mainBackAfterRestoreMs).toBeLessThanOrEqual(HIDDEN_RECONNECT_BUDGET_MS);
    expect(hiddenReconnect.terminalBackAfterRestoreMs).toBeLessThanOrEqual(
      HIDDEN_RECONNECT_BUDGET_MS,
    );

    // 3. Shown while waiting out a capped rung: an immediate retry.
    const secondOutageAt = Date.now();
    link.setMode("reset");
    await page.waitForTimeout(OUTAGE_MS);
    // Wait for a failed attempt, so the ladder's next rung is at least
    // CAP_RUNG_FLOOR_MS away; restore the link and show the tab right after.
    const lastFailure = Date.now();
    await expect
      .poll(() => firstAttempt(link, "main-stream", lastFailure), { timeout: 30_000 })
      .not.toBeNull();
    const failedAt = firstAttempt(link, "main-stream", lastFailure)!;
    await page.waitForTimeout(300);
    const secondRestoredAt = Date.now();
    link.setMode("up");
    await page.waitForTimeout(200);
    const shownAt = Date.now();
    const shownBy = await show(page, session);
    const visibleAt =
      (await snapshotOf(page)).visibility.findLast((entry) => entry.state === "visible")?.at ??
      Date.now();
    await expect
      .poll(() => firstAnswered(link, "main-stream", secondRestoredAt), { timeout: 30_000 })
      .not.toBeNull();
    await expect
      .poll(() => firstAnswered(link, "terminal-stream", secondRestoredAt), { timeout: 30_000 })
      .not.toBeNull();
    const mainRetryAt = firstAttempt(link, "main-stream", secondRestoredAt)!;
    const terminalRetryAt = firstAttempt(link, "terminal-stream", secondRestoredAt)!;
    const visibleRetry = {
      outageMs: secondRestoredAt - secondOutageAt,
      shownBy,
      hiddenThroughOutage: (await snapshotOf(page)).visibility
        .filter((entry) => entry.at >= secondOutageAt && entry.at < shownAt)
        .every((entry) => entry.state === "hidden"),
      lastFailedAttemptBeforeShowMs: shownAt - failedAt,
      ladderNextRungAtLeastMs: CAP_RUNG_FLOOR_MS,
      mainRetryAfterVisibleMs: mainRetryAt - visibleAt,
      terminalRetryAfterVisibleMs: terminalRetryAt - visibleAt,
      mainBackAfterVisibleMs: firstAnswered(link, "main-stream", secondRestoredAt)! - visibleAt,
      terminalBackAfterVisibleMs:
        firstAnswered(link, "terminal-stream", secondRestoredAt)! - visibleAt,
      budgetMs: VISIBLE_RETRY_BUDGET_MS,
    };
    writeEvidence(testInfo, "evidence-visible-retry", visibleRetry);
    // Well inside the capped rung, so the retry was the visibility edge's.
    expect(visibleRetry.hiddenThroughOutage).toBe(true);
    expect(visibleRetry.lastFailedAttemptBeforeShowMs).toBeLessThan(CAP_RUNG_FLOOR_MS - 2_000);
    expect(visibleRetry.mainRetryAfterVisibleMs).toBeLessThanOrEqual(VISIBLE_RETRY_BUDGET_MS);
    expect(visibleRetry.terminalRetryAfterVisibleMs).toBeLessThanOrEqual(VISIBLE_RETRY_BUDGET_MS);
    await expect(page.locator(".xterm:visible")).toHaveCount(1);
  } finally {
    await stopChrome(chrome);
    rmSync(userDataDir, { recursive: true, force: true });
    await link.close();
    await invoke("stop_environment", { environmentId: environment.id }).catch(() => undefined);
    await invoke("delete_environment", { environmentId: environment.id }).catch(() => undefined);
  }
});
