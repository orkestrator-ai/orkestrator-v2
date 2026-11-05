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

/**
 * Routes a context's loopback scripts and styles through Playwright's own
 * fetch, which no host network change aborts. The default context already has
 * this; call it for every context a case creates for a second client.
 */
export async function fetchModulesOutsideChromium(context: BrowserContext): Promise<void> {
  await context.route(LOOPBACK_URL, async (route) => {
    if (!isModuleLoad(route.request())) return route.fallback();
    try {
      await route.fulfill({ response: await route.fetch({ maxRetries: 2 }) });
    } catch {
      // The page navigated away or closed while this module was on its way.
      await route.abort().catch(() => undefined);
    }
  });
}
