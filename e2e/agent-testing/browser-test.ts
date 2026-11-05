import { test as base, type BrowserContext, type Request } from "@playwright/test";

export * from "@playwright/test";

/**
 * The browser suite's `test`. On Linux, Chromium aborts in-flight requests,
 * loopback included, with `net::ERR_NETWORK_CHANGED` whenever a host network
 * interface appears or disappears, and other builds' Docker work does that every
 * few seconds (flake 2340). A page that loses a module renders partly or not at
 * all, and the next assertion fails for a reason that has nothing to do with
 * the case. So every page in the default context fetches its scripts and
 * styles outside Chromium's network stack. Navigations, commands and event
 * streams still go through the browser.
 *
 * `browser-gateway.spec.ts` and `client-outage.spec.ts` keep `@playwright/test`
 * on purpose: they are about the browser's own network path, so a gateway fault
 * that only a browser sees still shows there.
 */
export const test = base.extend({
  context: async ({ context }, use) => {
    await fetchModulesOutsideChromium(context);
    await use(context);
  },
});

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

/**
 * Routes a context's loopback scripts and styles through Playwright's own
 * fetch, which no host network change aborts. The default context already has
 * this; call it for every context a case creates for a second client.
 */
export async function fetchModulesOutsideChromium(context: BrowserContext): Promise<void> {
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
