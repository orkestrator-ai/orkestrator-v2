import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { startPreviewHarnessClient, type PreviewHarnessClient } from "./harness-client";

/**
 * Vite fixture page loads through both preview routes, with the upstream
 * connections the application accepted and how many responses were
 * revalidated (304). Chromium only: it clears the HTTP cache through CDP.
 *
 * Needs `ORKESTRATOR_TEST_PREVIEW_VITE_DIR` (see test-fixtures/preview-vite).
 * `ORKESTRATOR_TEST_PREVIEW_VITE_PAGE` picks the page (default `/`), and
 * `ORKESTRATOR_TEST_PREVIEW_LOAD_SAMPLES` the samples per route (default 3), and
 * `ORKESTRATOR_TEST_PREVIEW_POOL_OFF=1` turns upstream connection reuse off.
 * Prints one `[preview-page-load]` JSON line; numbers are medians.
 */
const viteDir = process.env.ORKESTRATOR_TEST_PREVIEW_VITE_DIR;
const pagePath = process.env.ORKESTRATOR_TEST_PREVIEW_VITE_PAGE ?? "/";
const samples = Number(process.env.ORKESTRATOR_TEST_PREVIEW_LOAD_SAMPLES ?? 3);

let client: PreviewHarnessClient;

test.beforeAll(async ({ browserName }) => {
  test.skip(!viteDir, "Set ORKESTRATOR_TEST_PREVIEW_VITE_DIR");
  test.skip(browserName !== "chromium", "Clears the HTTP cache through CDP");
  client = await startPreviewHarnessClient(browserName);
});

test.afterAll(async () => {
  await client?.close();
});

interface Phase {
  ms: number;
  requests: number;
  /** 304s the browser reported (a sandboxed frame reports some as cache hits). */
  revalidated: number;
  /** 304s answered by the gateway on the legacy route, counted at its recorder. */
  gateway304: number;
  bytes: number;
  upstreamConnections: number;
}

async function gateway304s(): Promise<number> {
  const { requests } = await client.next<{ requests: Array<{ status: number | null }> }>(
    "gateway-requests",
    "gateway-requests",
  );
  return requests.filter((request) => request.status === 304).length;
}

async function connections(): Promise<number> {
  return (await client.next<{ accepted: number }>("connections", "connections vite")).accepted;
}

/** Run one navigation and count what crossed the wire for it. */
async function measure(page: Page, navigate: () => Promise<unknown>): Promise<Phase> {
  const finished: Array<Promise<{ status: number; bytes: number }>> = [];
  const onFinished = (request: import("@playwright/test").Request) => {
    finished.push(
      (async () => {
        const response = await request.response();
        const sizes = await request.sizes().catch(() => ({ responseBodySize: 0 }));
        return { status: response?.status() ?? 0, bytes: sizes.responseBodySize };
      })(),
    );
  };
  page.on("requestfinished", onFinished);
  const before = await connections();
  const before304 = await gateway304s();
  const started = performance.now();
  await navigate();
  const ms = performance.now() - started;
  // Let late module requests settle before reading the counts.
  await page.waitForLoadState("networkidle");
  page.off("requestfinished", onFinished);
  const results = await Promise.all(finished);
  return {
    ms: Math.round(ms),
    requests: results.length,
    revalidated: results.filter((result) => result.status === 304).length,
    gateway304: (await gateway304s()) - before304,
    bytes: results.reduce((total, result) => total + result.bytes, 0),
    upstreamConnections: (await connections()) - before,
  };
}

async function clearCache(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.clearBrowserCache");
  await cdp.detach();
}

function median(phases: Phase[]): Phase {
  const pick = (key: keyof Phase) => {
    const sorted = phases.map((phase) => phase[key]).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)]!;
  };
  return {
    ms: pick("ms"),
    requests: pick("requests"),
    revalidated: pick("revalidated"),
    gateway304: pick("gateway304"),
    bytes: pick("bytes"),
    upstreamConnections: pick("upstreamConnections"),
  };
}

type RouteResult = { first: Phase; again: Phase; cold: Phase };

/**
 * `open` signs in and loads the page; `load` loads it again in the same
 * context, first with a warm HTTP cache and then after clearing it.
 */
async function route(
  open: (context: BrowserContext, page: Page) => Promise<unknown>,
  load: (page: Page) => Promise<unknown>,
) {
  const runs: RouteResult[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const context = await client.newContext();
    const page = await context.newPage();
    try {
      const first = await measure(page, () => open(context, page));
      const again = await measure(page, () => load(page));
      await clearCache(context, page);
      const cold = await measure(page, () => load(page));
      runs.push({ first, again, cold });
    } finally {
      await context.close();
    }
  }
  return {
    first: median(runs.map((run) => run.first)),
    again: median(runs.map((run) => run.again)),
    cold: median(runs.map((run) => run.cold)),
  };
}

test("Vite page loads through the private origin and the legacy route", async () => {
  test.setTimeout(240_000);
  let origin = "";
  const privateOrigin = await route(
    async (_context, page) => {
      origin = (await client.signIn(page, "vite", pagePath)).origin;
    },
    (page) => page.goto(`${origin}${pagePath}`, { waitUntil: "load" }),
  );

  // The legacy route serves the sandboxed (`Origin: null`) frame the app embeds.
  const { token } = await client.next<{ token: string }>("gateway-token", "gateway-token");
  const gateway = client.ready.gateway;
  const legacyUrl = `${gateway}/__orkestrator/browser/loopback/${client.ready.loopbackPorts.vite}${pagePath}`;
  const frame = (page: Page) =>
    page.setContent(`<iframe sandbox="allow-scripts" src="${legacyUrl}"></iframe>`, {
      waitUntil: "load",
    });
  const legacy = await route(async (context, page) => {
    // Electron attaches the gateway bearer to the preview frame's requests.
    await context.setExtraHTTPHeaders({ authorization: `Bearer ${token}` });
    await frame(page);
    await expect(page.frames()[1]!.locator("#app")).not.toHaveText("loading");
  }, frame);

  const result = {
    page: pagePath,
    samples,
    pool: process.env.ORKESTRATOR_TEST_PREVIEW_POOL_OFF === "1" ? "off" : "on",
    privateOrigin,
    legacy,
  };
  console.log(`[preview-page-load] ${JSON.stringify(result)}`);
  test.info().annotations.push({ type: "preview-page-load", description: JSON.stringify(result) });

  // Every page load reached the application's module graph.
  expect(privateOrigin.first.requests).toBeGreaterThan(2);
  expect(legacy.first.requests).toBeGreaterThan(2);
});
