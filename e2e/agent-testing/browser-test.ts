import { spawnSync } from "node:child_process";
import { test as base, type BrowserContext, type Page, type Request } from "@playwright/test";
import { observeCommandInvokes } from "./invoke-observer";

export * from "@playwright/test";

/**
 * The browser suite's `test`. On Linux, Chromium aborts in-flight requests,
 * loopback included, with `net::ERR_NETWORK_CHANGED` whenever a host network
 * interface appears or disappears, and other builds' Docker work does that every
 * few seconds (flake 2340). A page that loses a module renders partly or not at
 * all, and the next assertion fails for a reason that has nothing to do with
 * the case. So every page in the default context fetches its scripts and
 * styles outside Chromium's network stack, and a `goto` or `reload` that
 * Chromium aborted that way is tried again. Navigations, commands and event
 * streams still go through the browser.
 *
 * `client-outage.spec.ts` keeps `@playwright/test` on purpose: it is about the
 * browser's own network path through outages. `browser-gateway.spec.ts` has one
 * case that sets `modulesThroughChromium`, so a gateway fault that only a
 * browser sees still shows there.
 */
export const test = base.extend<{ modulesThroughChromium: boolean }>({
  /**
   * Leaves the default context's module loads on Chromium's own network path.
   * Only a case that is about that path sets it, and it must survive a load
   * lost to a network change itself (see {@link directLoadOutcome}).
   */
  modulesThroughChromium: [false, { option: true }],
  context: async ({ context, modulesThroughChromium }, use) => {
    if (!modulesThroughChromium) await fetchModulesOutsideChromium(context);
    // Opt-in (plan item 2010): which path each invoke and listen took.
    await observeCommandInvokes(context);
    await use(context);
  },
});

/** The error Chromium gives a request it aborted because a host interface changed. */
export const NETWORK_CHANGED = "net::ERR_NETWORK_CHANGED";

/**
 * What was wrong with a module load Chromium answered, if anything. Chromium
 * keeps its own HTTP cache on its own network path, so a reload revalidates
 * and a 304 is as good as a 200.
 */
export function moduleStatusFailure(status: number): string | undefined {
  return status === 200 || status === 304 ? undefined : `HTTP ${status}`;
}

/**
 * How one page load went for a case that loads its modules through Chromium.
 * `failures` holds what went wrong with each module load (Chromium's error
 * text, or the HTTP status a load answered with). A load that lost modules
 * only to host network changes says nothing about the gateway and is worth
 * loading again; anything else is a real failure.
 */
export function directLoadOutcome(
  failures: readonly string[],
  rendered: boolean,
): "loaded" | "network-changed" | "failed" {
  if (failures.some((failure) => failure !== NETWORK_CHANGED)) return "failed";
  if (failures.length > 0) return "network-changed";
  return rendered ? "loaded" : "failed";
}

/** A loopback origin: the profile's gateway, its renderer, or a fixture server. */
export const LOOPBACK_URL = /^https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?\//;

const MODULE_RESOURCE_TYPES = new Set(["script", "stylesheet"]);

/** Whether a request is a module or stylesheet load this suite fetches itself. */
export function isModuleLoad(request: Pick<Request, "method" | "resourceType">): boolean {
  return request.method() === "GET" && MODULE_RESOURCE_TYPES.has(request.resourceType());
}

/** A module response as the route handler fulfils it. */
export type CachedModule = { status: number; headers: Record<string, string>; body: Buffer };

/**
 * One context's module responses, so a reload is served from memory. Routing
 * turns Chromium's HTTP cache off, and fetching every module through the test
 * process again on each reload took 15–20 s on a loaded host, long enough for a
 * reloaded page to miss its own assertions. Only complete 200 responses are
 * kept, within a byte budget; the renderer's sources do not change during a
 * case, and a module Vite rebuilds gets a new `?t=` URL.
 */
export class ModuleCache {
  private readonly entries = new Map<string, CachedModule>();
  private bytes = 0;

  constructor(private readonly maxBytes = 256 * 1024 * 1024) {}

  get(url: string): CachedModule | undefined {
    return this.entries.get(url);
  }

  set(url: string, module: CachedModule): void {
    if (module.status !== 200 || this.entries.has(url)) return;
    if (this.bytes + module.body.byteLength > this.maxBytes) return;
    this.entries.set(url, module);
    this.bytes += module.body.byteLength;
  }

  get size(): number {
    return this.entries.size;
  }
}

/** `body()` is already decoded, so drop what described the bytes on the wire. */
export function decodedBodyHeaders(headers: Record<string, string>): Record<string, string> {
  const { "content-encoding": _encoding, "content-length": _length, ...rest } = headers;
  return rest;
}

/** Whether a navigation failed only because Chromium saw a host interface change. */
export function isNetworkChangedNavigation(error: unknown): boolean {
  return error instanceof Error && error.message.includes(NETWORK_CHANGED);
}

/** Mint again after an ambiguous login navigation: the original code may be spent. */
function freshLoginUrl(previousUrl: string): string {
  const command = spawnSync(
    "mise",
    [
      "run",
      "dev:login",
      "--profile",
      process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa",
      "--json",
    ],
    {
      cwd: import.meta.dirname + "/../..",
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  if (command.status !== 0) throw new Error("dev:login failed while renewing a login link");
  const login = JSON.parse(command.stdout) as { loginUrl?: unknown };
  if (typeof login.loginUrl !== "string") throw new Error("dev:login returned no login URL");
  if (new URL(login.loginUrl).origin !== new URL(previousUrl).origin)
    throw new Error("Renewed login link belongs to a different test profile");
  return login.loginUrl;
}

/** Retry network-change aborts; one-shot login GETs need a fresh code each time. */
export function retryNavigationsOnNetworkChange(
  page: Page,
  attempts = 3,
  renewLoginUrl: (previousUrl: string) => string = freshLoginUrl,
): void {
  for (const method of ["goto", "reload"] as const) {
    const navigate = page[method].bind(page) as (...args: unknown[]) => Promise<unknown>;
    (page as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
      const login =
        method === "goto" &&
        typeof args[0] === "string" &&
        URL.canParse(args[0]) &&
        new URL(args[0]).pathname === "/__orkestrator/agent-test/login";
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await navigate(...args);
        } catch (error) {
          if (attempt >= attempts || !isNetworkChangedNavigation(error)) throw error;
          if (login) args[0] = renewLoginUrl(args[0] as string);
        }
      }
    };
  }
}

export const DIRECT_LOAD_ATTEMPTS = 4;
export const DIRECT_LOAD_WAIT_MS = 30_000;
// Preserve Playwright's usual 30-second navigation allowance on a loaded host.
export const DIRECT_LOAD_NAVIGATION_MS = 30_000;
// Two navigations per load, each with three attempts, plus UI wait, setup and
// 30 seconds of headroom for listener cleanup and final outcome classification.
export const DIRECT_LOAD_TIMEOUT_MS =
  150_000 + DIRECT_LOAD_ATTEMPTS * (2 * 3 * DIRECT_LOAD_NAVIGATION_MS + DIRECT_LOAD_WAIT_MS);

/** Keep exhausted churn distinct from real module failures and runner timeouts. */
export async function runDirectLoads(
  load: () => Promise<{ failures: string[]; rendered: boolean }>,
): Promise<void> {
  for (let attempt = 1; attempt <= DIRECT_LOAD_ATTEMPTS; attempt += 1) {
    const { failures, rendered } = await load();
    const outcome = directLoadOutcome(failures, rendered);
    if (outcome === "loaded") return;
    if (outcome !== "network-changed")
      throw new Error(
        failures.length
          ? `module loads failed: ${[...new Set(failures)].join(", ")}`
          : "the renderer did not load, and no module load failed",
      );
  }
  throw new Error(
    `All ${DIRECT_LOAD_ATTEMPTS} loads lost module requests to ${NETWORK_CHANGED}: host network interfaces kept changing (flake 2340)`,
  );
}

/**
 * Routes a context's loopback scripts and styles through Playwright's own
 * fetch, which no host network change aborts, and retries its pages'
 * navigations that one aborted. The default context already has this; call it
 * for every context a case creates for a second client.
 */
export async function fetchModulesOutsideChromium(context: BrowserContext): Promise<void> {
  await observeCommandInvokes(context);
  context.on("page", (page) => retryNavigationsOnNetworkChange(page));
  const cache = new ModuleCache();
  await context.route(LOOPBACK_URL, async (route) => {
    const request = route.request();
    if (!isModuleLoad(request)) return route.fallback();
    try {
      let module = cache.get(request.url());
      if (!module) {
        const response = await route.fetch({ maxRetries: 2 });
        module = {
          status: response.status(),
          headers: decodedBodyHeaders(response.headers()),
          body: await response.body(),
        };
        cache.set(request.url(), module);
      }
      await route.fulfill(module);
    } catch {
      // The page navigated away or closed while this module was on its way.
      await route.abort().catch(() => undefined);
    }
  });
}
