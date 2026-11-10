import { test, type Page, type Request } from "@playwright/test";

/**
 * A development Electron window loads its renderer's modules from Vite over
 * loopback, and on Linux Chromium aborts those loads with
 * `net::ERR_NETWORK_CHANGED` whenever another build's Docker work adds or
 * removes a host interface (flake 2340). The renderer then stops at
 * "Orkestrator couldn’t connect" and the spec fails at its first title check,
 * before its body runs (review validation of to-do 0042 task 11, 2026-11-06).
 *
 * The window is reloaded only for that failure: the startup screen is showing
 * and the console has both a failed module import and a network-change abort.
 * Any other startup failure, or more than `maxReloads` of these, fails as
 * before. A packaged build loads from `file:`, which the notifier never aborts,
 * so this cannot hide a failure a user would see. Every module and request
 * still goes through Chromium and main's request hooks.
 */
export const MODULE_IMPORT_FAILED = "Failed to fetch dynamically imported module";
export const NETWORK_CHANGED = "net::ERR_NETWORK_CHANGED";
export const STARTUP_FAILED_TEXT = "Orkestrator couldn’t connect";
export const DEFAULT_STARTUP_RELOADS = 3;

export type StartupStep = "ready" | "wait" | "reload" | "fail";

export interface StartupObservation {
  titleMatches: boolean;
  failureShown: boolean;
  /** Console lines seen since the last (re)load. */
  consoleLines: readonly string[];
  reloads: number;
  maxReloads: number;
}

/** Whether a failed start is the renderer losing its modules to a host network change. */
export function isNetworkChangedStartupFailure(consoleLines: readonly string[]): boolean {
  return (
    consoleLines.some((line) => line.includes(MODULE_IMPORT_FAILED)) &&
    consoleLines.some((line) => line.includes(NETWORK_CHANGED))
  );
}

export function nextStartupStep(observation: StartupObservation): StartupStep {
  if (observation.titleMatches) return "ready";
  if (!observation.failureShown) return "wait";
  if (!isNetworkChangedStartupFailure(observation.consoleLines)) return "fail";
  return observation.reloads < observation.maxReloads ? "reload" : "fail";
}

/** What the wait needs from a window; `pageStartupWindow` adapts a Playwright page. */
export interface StartupWindow {
  title(): Promise<string>;
  failureShown(): Promise<boolean>;
  reload(): Promise<unknown>;
  /** Lines seen since the last call; the caller keeps them until the next reload. */
  drainConsole(): string[];
}

/** A console message; `page()` names the window that logged it, when Playwright knows it. */
export interface StartupConsoleMessage {
  text(): string;
  page?(): unknown;
}

interface ConsoleSource {
  on(event: "request", listener: (request: Request) => void): unknown;
  off(event: "request", listener: (request: Request) => void): unknown;
  on(event: "console", listener: (message: StartupConsoleMessage) => void): unknown;
  off(event: "console", listener: (message: StartupConsoleMessage) => void): unknown;
}

export interface StartupConsole {
  /**
   * Lines seen since the last drain. With a `page`, only that window's lines
   * and lines no window claimed; other windows' lines wait for their own drain,
   * so one window's aborts never license another window's reload.
   */
  drain(page?: unknown): string[];
  dispose(): void;
}

/**
 * Keeps the console lines that decide a reload. Listen on the application's
 * context straight after launch: the first window's initial load reports its
 * aborts before `firstWindow()` resolves.
 */
export function collectStartupConsole(source: ConsoleSource): StartupConsole {
  let entries: Array<{ page: unknown; text: string }> = [];
  const listener = (message: StartupConsoleMessage) => {
    const text = message.text();
    const signature = text.includes(MODULE_IMPORT_FAILED)
      ? MODULE_IMPORT_FAILED
      : text.includes(NETWORK_CHANGED)
        ? NETWORK_CHANGED
        : null;
    if (!signature) return;
    let page: unknown = null;
    try {
      page = message.page?.() ?? null;
    } catch {
      // A closed page: keep the line unclaimed.
    }
    // A module fan-out can emit hundreds of aborts after the import rejection.
    // Keep one of each signature per window so the abort burst cannot evict
    // that rejection.
    if (!entries.some((entry) => entry.page === page && entry.text.includes(signature))) {
      entries.push({ page, text: text.slice(0, 300) });
    }
  };
  const navigationStarted = (request: Request) => {
    if (!request.isNavigationRequest()) return;
    try {
      const frame = request.frame();
      if (frame.parentFrame()) return;
      const page = frame.page();
      // Reset before the new document can log, rather than at waitForTitle:
      // callers often await reload before starting that wait. Unclaimed lines
      // cannot safely authorize recovery across a navigation either.
      entries = entries.filter((entry) => entry.page !== page && entry.page !== null);
    } catch {
      // Initial navigation can precede frame creation; no previous document
      // exists to clear in that case.
    }
  };
  source.on("request", navigationStarted);
  source.on("console", listener);
  return {
    drain: (page?: unknown) => {
      const matches = (entry: { page: unknown }) =>
        page === undefined || entry.page === page || entry.page === null;
      const drained = entries.filter(matches).map((entry) => entry.text);
      entries = entries.filter((entry) => !matches(entry));
      return drained;
    },
    dispose: () => {
      source.off("console", listener);
      source.off("request", navigationStarted);
    },
  };
}

export function pageStartupWindow(page: Page, console: StartupConsole): StartupWindow {
  return {
    title: () => page.title(),
    // Present, not "visible": headless Ozone ignores a window's constructor
    // size, so until a spec sizes it the window is 1x1 and the startup panel's
    // heading has no box. The renderer adds that heading only when start fails.
    failureShown: async () => (await page.getByText(STARTUP_FAILED_TEXT).count()) > 0,
    reload: () => page.reload(),
    drainConsole: () => console.drain(page),
  };
}

export class RendererStartupError extends Error {}

/**
 * Waits for the window's title, reloading it after a network-change startup
 * failure. Resolves with the number of reloads it took.
 */
export async function waitForRendererStart(
  window: StartupWindow,
  title: string | RegExp,
  {
    timeoutMs = 60_000,
    pollMs = 250,
    maxReloads = DEFAULT_STARTUP_RELOADS,
    now = Date.now,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  }: {
    timeoutMs?: number;
    pollMs?: number;
    maxReloads?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<number> {
  const deadline = now() + timeoutMs;
  let consoleLines: string[] = [];
  let reloads = 0;
  let lastTitle = "";
  while (now() < deadline) {
    // A navigation in progress has no title to read yet.
    lastTitle = await window.title().catch(() => "");
    const failureShown = await window.failureShown().catch(() => false);
    consoleLines.push(...window.drainConsole());
    const step = nextStartupStep({
      titleMatches: typeof title === "string" ? lastTitle === title : title.test(lastTitle),
      failureShown,
      consoleLines,
      reloads,
      maxReloads,
    });
    if (step === "ready") return reloads;
    if (step === "fail") {
      const reason = isNetworkChangedStartupFailure(consoleLines)
        ? `still failing after ${reloads} reloads for ${NETWORK_CHANGED} (flake 2340)`
        : "not a network-change module failure";
      throw new RendererStartupError(
        `Renderer showed "${STARTUP_FAILED_TEXT}" (${reason}); title "${lastTitle}", expected "${title}"`,
      );
    }
    if (step === "reload") {
      reloads += 1;
      // Drop the failed load's lines before reloading, so the next decision
      // reads only what the reloaded page reports.
      consoleLines = [];
      window.drainConsole();
      await window.reload().catch(() => undefined);
      continue;
    }
    await sleep(pollMs);
  }
  throw new RendererStartupError(
    `Renderer title stayed "${lastTitle}" for ${timeoutMs} ms, expected "${title}" (${reloads} reloads)`,
  );
}

export interface ElectronStartupWatch {
  /**
   * Waits for `window` to show `title`, reloading it only after a
   * network-change module failure (above). A reload is recorded as a
   * `startup-recovery` annotation on the running test and printed as a
   * `[startup-recovery]` line, so a passing run still shows it recovered.
   * Resolves with the number of reloads.
   */
  waitForTitle(
    window: Page,
    title: string | RegExp,
    options?: { timeoutMs?: number; maxReloads?: number },
  ): Promise<number>;
  /**
   * Stops collecting. The watch serves later windows and reloads until this is
   * called; it also ends with the application's context.
   */
  dispose(): void;
}

/** Records a recovered start where a passing run's report shows it. */
export function noteStartupRecovery(reloads: number): void {
  if (reloads === 0) return;
  const description = `renderer start reloaded ${reloads}x after ${NETWORK_CHANGED}`;
  try {
    test.info().annotations.push({ type: "startup-recovery", description });
  } catch {
    // Outside a running test (a unit test of this module): the line below is enough.
  }
  console.log(`[startup-recovery] ${description}`);
}

/**
 * One launch's startup recovery for a development Electron app. Call it
 * straight after `electron.launch()` (before `firstWindow()`), then use
 * `waitForTitle` wherever the spec waited for a window's first title. Not for
 * a case that asserts on startup failure itself (a missing preload, the
 * startup markers a window sends): a reload there would hide what it is about.
 */
export function watchElectronStartup(app: { context(): ConsoleSource }): ElectronStartupWatch {
  const startupConsole = collectStartupConsole(app.context());
  return {
    async waitForTitle(window, title, { timeoutMs = 60_000, maxReloads } = {}) {
      const reloads = await waitForRendererStart(pageStartupWindow(window, startupConsole), title, {
        timeoutMs,
        ...(maxReloads === undefined ? {} : { maxReloads }),
      });
      noteStartupRecovery(reloads);
      return reloads;
    },
    dispose: () => startupConsole.dispose(),
  };
}
