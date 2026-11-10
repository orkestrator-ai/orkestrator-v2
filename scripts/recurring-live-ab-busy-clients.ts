import { spawnSync } from "node:child_process";
import path from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import { startOutageLink, type OutageLink } from "../e2e/agent-testing/client-outage-support";
import type { BusyClient, BusyClientFactory } from "./recurring-live-ab-busy";
import { FAKE_REPLY } from "./recurring-live-ab-fake-model";

/**
 * Headless Chromium clients for the busy phase (`recurring-live-ab-busy.ts`).
 *
 * Each client is its own browser context signed in with a one-shot
 * `dev:login` link, which is parsed in memory and never printed. With two
 * clients the second reaches the gateway through the outage link of
 * `e2e/agent-testing/client-outage-support.ts`, so the phase can cut it
 * without touching the host's network. Every client shows the approval
 * environment's Pi tab, so the approval card and the mail chip are in its
 * active view; the sidebar shows every environment's activity marker and
 * change badge. A client's review view is a second context of its own,
 * signed in the same way and through the same link, opened on the review
 * environment so the Multi Review tab can be watched from its launch; a
 * recorder in that page notes each phase its header shows
 * (`data-phase`, `data-workflow-id` on `multi-review-phase`) and when.
 *
 * Browsers are launched headless with no display, so nothing opens on the
 * host's desktop.
 */

export type BusyClientStatus = { browserUrl?: string; rendererUrl?: string };

const STARTUP_NOTICES = [
  "Continue Without Docker",
  "Continue Without GitHub CLI",
  "Continue Without Claude",
] as const;

function loginPath(profile: string): string {
  const command = spawnSync("mise", ["run", "dev:login", "--profile", profile, "--json"], {
    encoding: "utf8",
  });
  if (command.status !== 0) throw new Error("dev:login failed");
  const login = JSON.parse(command.stdout) as { loginUrl?: unknown };
  if (typeof login.loginUrl !== "string") throw new Error("dev:login returned no login URL");
  const url = new URL(login.loginUrl);
  return `${url.pathname}${url.search}`;
}

/** The sidebar row's activity marker state for one environment (runs in the page). */
function markerStateIn(environmentName: string): string | null {
  for (const label of Array.from(document.querySelectorAll("span[id]"))) {
    if (label.textContent !== environmentName) continue;
    const marker = label
      .closest('[role="button"]')
      ?.querySelector('[data-testid="environment-status-marker"]');
    if (marker) return marker.getAttribute("data-state");
  }
  return null;
}

/**
 * Records each phase the named review's header shows, and when (wall clock),
 * into `window.__busyReviewPhases` (runs in the page). A mutation observer
 * catches React's commit; a 25 ms check catches a header that only becomes
 * visible. Only a visible header of this workflow counts.
 */
function recordReviewPhasesIn(workflowId: string) {
  type Recorder = {
    __busyReviewPhases?: Array<{ phase: string; at: number }>;
    __busyReviewStop?: () => void;
  };
  const target = window as unknown as Recorder;
  target.__busyReviewStop?.();
  const sightings: Array<{ phase: string; at: number }> = [];
  target.__busyReviewPhases = sightings;
  const read = () => {
    for (const element of Array.from(
      document.querySelectorAll('[data-testid="multi-review-phase"]'),
    )) {
      if (element.getAttribute("data-workflow-id") !== workflowId) continue;
      const visible =
        typeof element.checkVisibility === "function"
          ? element.checkVisibility()
          : (element as HTMLElement).offsetParent !== null;
      if (!visible) continue;
      const phase = element.getAttribute("data-phase");
      if (phase && sightings.at(-1)?.phase !== phase) sightings.push({ phase, at: Date.now() });
      return;
    }
  };
  const observer = new MutationObserver(read);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["data-phase", "data-workflow-id", "class", "style", "hidden"],
  });
  const timer = window.setInterval(read, 25);
  target.__busyReviewStop = () => {
    observer.disconnect();
    window.clearInterval(timer);
  };
  read();
}

function reviewPhasesIn(): Array<{ phase: string; at: number }> {
  return (
    (window as unknown as { __busyReviewPhases?: Array<{ phase: string; at: number }> })
      .__busyReviewPhases ?? []
  ).slice();
}

/**
 * Moves wall-clock sightings from the page onto this process's monotonic
 * clock (`performance.now()`, the busy runtime's clock). Page and process
 * share the host's clock.
 */
export function toProcessClock(
  sightings: ReadonlyArray<{ phase: string; at: number }>,
  wallNow = Date.now(),
  processNow = performance.now(),
): Array<{ phase: string; at: number }> {
  return sightings.map((sighting) => ({
    phase: sighting.phase,
    at: processNow - (wallNow - sighting.at),
  }));
}

/** The element id suffix of a review's root tab (`createPaneTabElementId`). */
export function reviewTabIdSuffix(workflowId: string): string {
  return `:${encodeURIComponent(`multi-review:${workflowId}`)}`;
}

/** Every sidebar row's change-badge additions, by environment name (runs in the page). */
function badgesIn(): Record<string, number | null> {
  const badges: Record<string, number | null> = {};
  for (const label of Array.from(document.querySelectorAll("span[id]"))) {
    const name = label.textContent ?? "";
    const row = label.closest('[role="button"]');
    if (!name || !row || !row.querySelector('[data-testid="environment-status-marker"]')) continue;
    const badge = row.querySelector(
      '[data-testid="environment-change-badge"], [data-testid="environment-diff-stats"]',
    );
    const match = /\+(\d[\d,]*)/.exec(badge?.textContent ?? "");
    badges[name] = match ? Number(match[1]!.replaceAll(",", "")) : null;
  }
  return badges;
}

/** Rendered transcript rows holding the fake model's reply (runs in the page). */
function replyCountIn(reply: string): number {
  let count = 0;
  for (const row of Array.from(document.querySelectorAll("[data-chat-message-index]")))
    if ((row.textContent ?? "").includes(reply)) count += 1;
  return count;
}

/** The open tab's agent-mail chip count (runs in the page). */
function mailCountIn(): number {
  for (const button of Array.from(document.querySelectorAll("button[aria-label]"))) {
    const label = button.getAttribute("aria-label") ?? "";
    if (!label.startsWith("Agent mail:")) continue;
    const match = /(\d+) messages? in inbox/.exec(label);
    if (match) return Number(match[1]);
  }
  return 0;
}

function setHiddenIn(hidden: boolean) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event("visibilitychange"));
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Dismisses startup notices and selects an environment in the sidebar. */
async function selectEnvironment(page: Page, environmentName: string): Promise<void> {
  const expand = page.getByRole("button", { name: /^Expand project / });
  // The sidebar row, by its accessible name ("<name>, on <host>, <activity>"):
  // the bare name also appears in notices and mail.
  const entry = page
    .getByRole("button", { name: new RegExp(`^${escaped(environmentName)}, `) })
    .first();
  const dialog = page.getByRole("alertdialog");
  // Startup notices can open before or a moment after the sidebar paints.
  // A page that has painted nothing after 45 s lost a module load (Chromium
  // aborts them when the host's network changes, which Docker does whenever
  // another profile starts); reload it, twice at most.
  let quietSince = Date.now();
  let paintedOnce = false;
  let reloads = 0;
  let loadedAt = Date.now();
  for (const deadline = Date.now() + 180_000; Date.now() < deadline;) {
    for (const label of STARTUP_NOTICES) {
      const button = page.getByRole("button", { name: label, exact: true });
      if (await button.isVisible().catch(() => false))
        await button.click({ timeout: 5_000 }).catch(() => undefined);
    }
    const blocked = await dialog
      .first()
      .isVisible()
      .catch(() => false);
    const painted = await expand
      .or(entry)
      .first()
      .isVisible()
      .catch(() => false);
    paintedOnce ||= painted || blocked;
    if (!paintedOnce && reloads < 2 && Date.now() - loadedAt > 45_000) {
      reloads += 1;
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
      loadedAt = Date.now();
    }
    if (blocked || !painted) quietSince = Date.now();
    else if (Date.now() - quietSince >= 2_000) break;
    await page.waitForTimeout(200);
  }
  if (await expand.first().isVisible()) await expand.first().click({ timeout: 10_000 });
  await entry.click({ timeout: 30_000 });
}

async function openApprovalTab(page: Page, environmentName: string): Promise<void> {
  await selectEnvironment(page, environmentName);
  const tab = page.getByRole("tab", { name: /^Pi \d/ }).first();
  await tab.click({ timeout: 60_000 });
  await page
    .getByRole("textbox", { name: /^Message Pi/ })
    .first()
    .waitFor({ state: "visible", timeout: 60_000 });
}

/**
 * A client factory bound to one profile, sharing one headless browser. A
 * client that cannot open its view leaves a screenshot of the fixture UI in
 * `artifactDir` (no token or credential is ever on the page).
 */
export function playwrightBusyClients(
  profile: string,
  status: BusyClientStatus,
  artifactDir?: string,
  dependencies?: {
    launch(): Promise<Browser>;
    loginPath(profile: string): string;
    openTab(page: Page, environment: string): Promise<void>;
    selectEnvironment?(page: Page, environment: string): Promise<void>;
  },
) {
  let failures = 0;
  let browser: Browser | undefined;
  const open: BusyClientFactory = async ({ count, openEnvironment, signal }) => {
    if (!status.browserUrl || !status.rendererUrl)
      throw new Error("The profile reports no browser or renderer URL");
    browser ??= dependencies
      ? await dependencies.launch()
      : await (await import("playwright")).chromium.launch({ headless: true });
    const clients: BusyClient[] = [];
    try {
      for (let index = 0; index < count; index += 1) {
        signal?.throwIfAborted();
        const label = `client-${index + 1}`;
        const linked = index === 1;
        const link: OutageLink | undefined = linked
          ? await startOutageLink({
              owner: label,
              gatewayUrl: status.browserUrl,
              rendererUrl: status.rendererUrl,
            })
          : undefined;
        let context: BrowserContext | undefined;
        const base = link?.url ?? status.browserUrl;
        const signIn = async (target: BrowserContext): Promise<Page> => {
          const page = await target.newPage();
          page.setDefaultTimeout(30_000);
          const response = await page.goto(
            new URL((dependencies?.loginPath ?? loginPath)(profile), base).href,
            { waitUntil: "domcontentloaded" },
          );
          if (!response?.ok()) throw new Error(`${label}: sign-in failed`);
          return page;
        };
        try {
          context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
          const page = await signIn(context);
          try {
            await (dependencies?.openTab ?? openApprovalTab)(page, openEnvironment);
          } catch (error) {
            if (artifactDir)
              await page
                .screenshot({
                  path: path.join(
                    artifactDir,
                    `${profile}-${label}-open-failure-${++failures}.png`,
                  ),
                })
                .catch(() => undefined);
            throw error;
          }
          const shared = browser;
          clients.push(
            pageClient(label, page, context, link, {
              async open(environmentName) {
                const reviewContext = await shared.newContext({
                  viewport: { width: 1440, height: 1000 },
                });
                try {
                  const reviewPage = await signIn(reviewContext);
                  await (dependencies?.selectEnvironment ?? selectEnvironment)(
                    reviewPage,
                    environmentName,
                  );
                  return { page: reviewPage, context: reviewContext };
                } catch (error) {
                  if (artifactDir) {
                    const pages = reviewContext.pages();
                    await pages[pages.length - 1]
                      ?.screenshot({
                        path: path.join(
                          artifactDir,
                          `${profile}-${label}-review-open-failure-${++failures}.png`,
                        ),
                      })
                      .catch(() => undefined);
                  }
                  await reviewContext.close().catch(() => undefined);
                  throw error;
                }
              },
              reopen: (reviewPage, environmentName) =>
                (dependencies?.selectEnvironment ?? selectEnvironment)(reviewPage, environmentName),
            }),
          );
        } catch (error) {
          await context?.close().catch(() => undefined);
          await link?.close().catch(() => undefined);
          throw error;
        }
      }
      return clients;
    } catch (error) {
      await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
      throw error;
    }
  };
  return {
    open,
    async close() {
      await browser?.close().catch(() => undefined);
      browser = undefined;
    },
  };
}

/** How a client opens its review view: a signed-in page on an environment. */
export type ReviewViewOpener = {
  open(environmentName: string): Promise<{ page: Page; context: BrowserContext }>;
  /** Reloads and selects the environment again (a tab that never arrived). */
  reopen(page: Page, environmentName: string): Promise<void>;
};

/** A review's tab is in the layout once the launch returns; allow it to arrive. */
const REVIEW_TAB_WAIT_MS = 15_000;

export function pageClient(
  label: string,
  page: Page,
  context: BrowserContext,
  link: OutageLink | undefined,
  reviewViews?: ReviewViewOpener,
): BusyClient {
  // A page that is navigating or closed answers "not yet", never a throw.
  const read = async <T>(fallback: T, run: () => Promise<T>) => run().catch(() => fallback);
  let review: { page: Page; context: BrowserContext; environment: string } | undefined;
  return {
    label,
    linked: Boolean(link),
    markerState: (environmentName) =>
      read(null, () => page.evaluate(markerStateIn, environmentName)),
    badges: () => read({}, () => page.evaluate(badgesIn)),
    approvalVisible: () =>
      read(false, () =>
        page
          .getByRole("group", { name: "Approve command" })
          .getByRole("button", { name: "Approve", exact: true })
          .first()
          .isVisible(),
      ),
    replyCount: () => read(0, () => page.evaluate(replyCountIn, FAKE_REPLY)),
    mailCount: () => read(0, () => page.evaluate(mailCountIn)),
    setHidden: async (hidden) => {
      await page.evaluate(setHiddenIn, hidden);
    },
    prepareReview: async (environmentName) => {
      if (!reviewViews) throw new Error(`${label} has no review view`);
      if (review?.environment === environmentName) return;
      await review?.context.close().catch(() => undefined);
      review = { ...(await reviewViews.open(environmentName)), environment: environmentName };
    },
    watchReview: async (workflowId) => {
      if (!review || !reviewViews) throw new Error(`${label}: no review view is open`);
      const view = review;
      // Recording starts before the tab is selected, so the first sighting
      // is the moment the review's header first shows.
      await view.page.evaluate(recordReviewPhasesIn, workflowId);
      const tab = view.page.locator(`[role="tab"][id$="${reviewTabIdSuffix(workflowId)}"]`).first();
      const arrived = await tab
        .waitFor({ state: "visible", timeout: REVIEW_TAB_WAIT_MS })
        .then(() => true)
        .catch(() => false);
      if (!arrived) {
        await view.page.reload({ waitUntil: "domcontentloaded" });
        await reviewViews.reopen(view.page, view.environment);
        await view.page.evaluate(recordReviewPhasesIn, workflowId);
        await tab.waitFor({ state: "visible", timeout: 2 * REVIEW_TAB_WAIT_MS });
      }
      if ((await tab.getAttribute("aria-selected")) !== "true")
        await tab.click({ timeout: 10_000 });
    },
    reviewPhases: async () =>
      toProcessClock(
        await read([], () => review?.page.evaluate(reviewPhasesIn) ?? Promise.resolve([])),
      ),
    setLinkUp: (up) => {
      if (!link) throw new Error(`${label} has no link to cut`);
      link.setMode(up ? "up" : "reset");
    },
    close: async () => {
      await review?.context.close().catch(() => undefined);
      review = undefined;
      await context.close().catch(() => undefined);
      await link?.close().catch(() => undefined);
    },
  };
}
