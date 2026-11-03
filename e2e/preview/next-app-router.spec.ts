import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { startPreviewHarnessClient, type PreviewHarnessClient } from "./harness-client";

/**
 * The Next.js app-router fixture (`test-fixtures/preview-next`) through the
 * private preview origin: a streamed Suspense boundary, hydration, client-side
 * router navigation and deep links, a Server Action, what a route handler sees
 * of the request, an absolute redirect, and Fast Refresh over the HMR socket.
 *
 * Needs `ORKESTRATOR_TEST_PREVIEW_NEXT_DIR`, an installed copy of the fixture
 * (see its README). The Fast Refresh case edits `app/hmr-label.js` in that copy
 * and puts it back.
 */
const nextDir = process.env.ORKESTRATOR_TEST_PREVIEW_NEXT_DIR;
/** Matches `STREAM_DELAY_MS` in the fixture's `app/page.js`. */
const STREAM_DELAY_MS = 1500;

let client: PreviewHarnessClient;
let context: BrowserContext;
let page: Page;
let origin = "";

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browserName }, testInfo) => {
  test.skip(!nextDir, "Set ORKESTRATOR_TEST_PREVIEW_NEXT_DIR");
  // `next dev` starts and compiles the first page inside the harness.
  testInfo.setTimeout(240_000);
  client = await startPreviewHarnessClient(browserName, {
    ORKESTRATOR_TEST_PREVIEW_HARNESS_NEXT_DIR: nextDir!,
  });
  context = await client.newContext();
  page = await context.newPage();
  origin = (await client.signIn(page, "next", "/")).origin;
});

test.afterAll(async () => {
  await context?.close();
  await client?.close();
});

async function home(): Promise<void> {
  await page.goto(`${origin}/`, { waitUntil: "load" });
  await expect(page.locator("#title")).toHaveText("Preview Next fixture");
}

/** Hydration is done once a client component answers a click. */
async function hydrated(): Promise<void> {
  const counter = page.locator("#counter");
  await expect(async () => {
    const before = Number((await counter.textContent())?.replace(/\D+/g, "") ?? "0");
    await counter.click();
    await expect(counter).toHaveText(`count ${before + 1}`, { timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
}

test("the Suspense boundary streams through the private origin", async () => {
  await home();
  await expect(page.locator("#streamed")).toBeVisible();

  // Read the same document as a stream, timing when each marker first arrives.
  const timing = await page.evaluate(async () => {
    const started = performance.now();
    const response = await fetch("/", { cache: "no-store" });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let fallbackMs: number | null = null;
    let streamedMs: number | null = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      const now = performance.now() - started;
      if (fallbackMs === null && text.includes('id="stream-fallback"')) fallbackMs = now;
      if (streamedMs === null && text.includes('id="streamed"')) streamedMs = now;
    }
    return { status: response.status, fallbackMs, streamedMs };
  });
  expect(timing.status).toBe(200);
  expect(timing.fallbackMs).not.toBeNull();
  expect(timing.streamedMs).not.toBeNull();
  // A buffered response would deliver both markers together.
  expect(timing.streamedMs! - timing.fallbackMs!).toBeGreaterThan(STREAM_DELAY_MS / 2);
});

test("hydrates, navigates client-side and serves deep links", async () => {
  await home();
  await hydrated();
  await page.evaluate(() => {
    (window as unknown as { previewMarker: string }).previewMarker = "kept";
  });

  await page.locator("#item-link").click();
  await expect(page).toHaveURL(`${origin}/items/42`);
  await expect(page.locator("#item")).toHaveText("Item 42");
  await page.locator("#home-link").click();
  await expect(page).toHaveURL(`${origin}/`);
  // Wait for the streamed boundary so the next navigation does not cut it off.
  await expect(page.locator("#streamed")).toBeVisible();
  // Both moves went through the router's RSC requests, not a document load.
  expect(
    await page.evaluate(() => (window as unknown as { previewMarker?: string }).previewMarker),
  ).toBe("kept");

  await page.goto(`${origin}/items/7`, { waitUntil: "load" });
  await expect(page.locator("#item")).toHaveText("Item 7");
});

test("a Server Action accepts the mapped origin", async () => {
  await home();
  await hydrated();
  await page.locator("#action-text").fill("through the preview");
  await page.locator("#action-submit").click();
  await expect(page.locator("#action-result")).toHaveText("echo: through the preview");
});

test("a route handler sees the private authority and the public scheme", async () => {
  const response = await page.goto(`${origin}/api/request`);
  expect(response?.status()).toBe(200);
  const seen = (await response!.json()) as {
    host: string;
    forwardedHost: string | null;
    forwardedProto: string | null;
  };
  expect(seen.host).toMatch(/^localhost:\d+$/);
  // A navigation carries no Origin, so the public host is forwarded.
  expect(seen.forwardedHost).toBe(new URL(origin).host);
  expect(seen.forwardedProto).toBe("https");
});

test("an absolute redirect built from the request URL returns to the public origin", async () => {
  await page.goto(`${origin}/go`, { waitUntil: "load" });
  await expect(page).toHaveURL(`${origin}/items/7`);
  await expect(page.locator("#item")).toHaveText("Item 7");
});

test("Fast Refresh reaches the page over the preview HMR socket", async ({ browserName }) => {
  const file = path.join(nextDir!, "app/hmr-label.js");
  const original = await readFile(file, "utf8");
  const updated = `hmr-updated-${browserName}`;
  await home();
  await hydrated();
  const count = await page.locator("#counter").textContent();
  await page.evaluate(() => {
    (window as unknown as { previewMarker: string }).previewMarker = "hmr";
  });
  try {
    await writeFile(file, original.replace("hmr-initial", updated));
    await expect(page.locator("#hmr-label")).toHaveText(updated, { timeout: 30_000 });
    // Fast Refresh, not a reload: page state and the counter survive.
    expect(
      await page.evaluate(() => (window as unknown as { previewMarker?: string }).previewMarker),
    ).toBe("hmr");
    await expect(page.locator("#counter")).toHaveText(count!);
  } finally {
    await writeFile(file, original);
  }
  await expect(page.locator("#hmr-label")).toHaveText("hmr-initial", { timeout: 30_000 });
});
