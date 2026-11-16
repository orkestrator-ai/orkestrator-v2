import { expect, test } from "@playwright/test";
import { startPreviewHarnessClient, type PreviewHarnessClient } from "./harness-client";

/**
 * Real browsers against the private-origin proxy's upstream connection pool:
 *
 * - a page load and its follow-up requests share upstream connections;
 * - revoking access, or moving the service to a new endpoint generation,
 *   closes the idle ones at once.
 *
 * The harness keeps idle connections for a minute here, so a connection that
 * closes during a test was closed by revocation, not by the idle timeout.
 */
let client: PreviewHarnessClient;

test.beforeAll(async ({ browserName }) => {
  client = await startPreviewHarnessClient(browserName, {
    ORKESTRATOR_TEST_PREVIEW_POOL_IDLE_MS: "60000",
  });
});

test.afterAll(async () => {
  await client?.close();
});

type Connections = { accepted: number; open: number };
type FixtureRequests = { requests: Array<{ path: string }> };

const connections = (name: string) =>
  client.next<Connections>("connections", `connections ${name}`);
const requestsAt = async (name: string) =>
  (await client.next<FixtureRequests>("fixture-requests", `fixture-requests ${name}`)).requests
    .length;

/** Load the page, then fetch its assets one after another, all through the origin. */
async function loadAndFetch(page: import("@playwright/test").Page) {
  await page.reload();
  await expect(page.locator("body")).toHaveAttribute("data-loaded", "browser-pool");
  await page.evaluate(async () => {
    for (const path of ["/health", "/assets/app.css", "/assets/app.js", "/health", "/health"]) {
      await (await fetch(path, { cache: "no-store" })).text();
    }
  });
}

test("a page and its requests share upstream connections; revocation closes the idle ones", async () => {
  const context = await client.newContext();
  const page = await context.newPage();
  await client.signIn(page, "pool");
  const before = { connections: await connections("pool"), requests: await requestsAt("pool") };
  await loadAndFetch(page);
  const after = { connections: await connections("pool"), requests: await requestsAt("pool") };
  const requests = after.requests - before.requests;
  const opened = after.connections.accepted - before.connections.accepted;
  expect(requests).toBeGreaterThanOrEqual(8);
  // Never more connections than the browser had requests in flight at once.
  expect(opened).toBeLessThan(requests);
  // Idle connections stay open at the application, ready for the next request.
  expect(after.connections.open).toBeGreaterThan(0);

  await client.next("revoked", "revoke");
  await expect.poll(async () => (await connections("pool")).open, { timeout: 5_000 }).toBe(0);
  const response = await page.reload();
  expect(response?.status()).toBeGreaterThanOrEqual(400);
  await context.close();
});

test("a new endpoint generation closes idle upstream connections", async () => {
  const context = await client.newContext();
  const page = await context.newPage();
  await client.signIn(page, "pool");
  await loadAndFetch(page);
  expect((await connections("pool")).open).toBeGreaterThan(0);

  const { generation } = await client.next<{ generation: number | null }>("rebound", "rebind pool");
  expect(generation).not.toBeNull();
  await expect.poll(async () => (await connections("pool")).open, { timeout: 5_000 }).toBe(0);
  // The old generation's session no longer reaches any application.
  const alternate = await connections("pool-alt");
  expect((await page.reload())?.status()).toBeGreaterThanOrEqual(400);
  expect((await connections("pool-alt")).accepted).toBe(alternate.accepted);

  // A fresh session reaches the new target.
  const fresh = await context.newPage();
  await client.signIn(fresh, "pool");
  await expect(fresh.locator("body")).toHaveAttribute("data-service-marker", "browser-pool-alt");
  await context.close();
  await client.next("rebound", "rebind pool");
});
