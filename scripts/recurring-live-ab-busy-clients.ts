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
 * change badge.
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

async function openApprovalTab(page: Page, environmentName: string): Promise<void> {
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
) {
  let failures = 0;
  let browser: Browser | undefined;
  const open: BusyClientFactory = async ({ count, openEnvironment, signal }) => {
    if (!status.browserUrl || !status.rendererUrl)
      throw new Error("The profile reports no browser or renderer URL");
    const { chromium } = await import("playwright");
    browser ??= await chromium.launch({ headless: true });
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
        try {
          context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
          const page = await context.newPage();
          page.setDefaultTimeout(30_000);
          const base = link?.url ?? status.browserUrl;
          const response = await page.goto(new URL(loginPath(profile), base).href, {
            waitUntil: "domcontentloaded",
          });
          if (!response?.ok()) throw new Error(`${label}: sign-in failed`);
          try {
            await openApprovalTab(page, openEnvironment);
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
          clients.push(pageClient(label, page, context, link));
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

function pageClient(
  label: string,
  page: Page,
  context: BrowserContext,
  link: OutageLink | undefined,
): BusyClient {
  // A page that is navigating or closed answers "not yet", never a throw.
  const read = async <T>(fallback: T, run: () => Promise<T>) => run().catch(() => fallback);
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
    setLinkUp: (up) => {
      if (!link) throw new Error(`${label} has no link to cut`);
      link.setMode(up ? "up" : "reset");
    },
    close: async () => {
      await context.close().catch(() => undefined);
      await link?.close().catch(() => undefined);
    },
  };
}
