import { expect, type BrowserContext, type Page } from "@playwright/test";

/**
 * Watch the page's main gateway event stream, cut it, and prove it came back.
 *
 * `context.setOffline(true)` fails new requests but leaves an open event
 * stream connected, so events keep arriving and nothing reconnects
 * (docs/development/agent-testing.md, "Offline is not a dropped stream").
 * `cut` therefore also calls `window.stop()` while offline, which aborts the
 * stream; the gateway client logs the drop and reconnects from its cursor once
 * the browser is back online.
 *
 * The main stream is `/events` without `includeEvents` (that parameter marks a
 * terminal stream). `requests` counts every attempt, including those that fail
 * while offline; `connects` counts only answered (2xx) requests, so a
 * reconnection is never inferred from a retry that the outage refused.
 */
export function watchEventStream(page: Page, trace?: (line: string) => void) {
  const counts = { drops: 0, requests: 0, connects: 0 };
  let connectsAtCut: number | undefined;
  const isMainStream = (url: string) => {
    const parsed = new URL(url);
    return parsed.pathname.endsWith("/events") && !parsed.searchParams.has("includeEvents");
  };
  page.on("console", (message) => {
    if (!message.text().includes("[RemoteGateway]")) return;
    if (message.text().includes("Event stream disconnected")) counts.drops += 1;
    trace?.(`console: ${message.text()}`);
  });
  page.on("request", (request) => {
    if (!isMainStream(request.url())) return;
    counts.requests += 1;
    trace?.(`event stream request ${new URL(request.url()).search}`);
  });
  page.on("response", (response) => {
    if (!isMainStream(response.url())) return;
    if (response.ok()) counts.connects += 1;
    trace?.(`event stream response ${response.status()}`);
  });
  page.on("requestfailed", (request) => {
    if (isMainStream(request.url())) {
      trace?.(`event stream request failed: ${request.failure()?.errorText}`);
    }
  });

  return {
    get drops() {
      return counts.drops;
    },
    get requests() {
      return counts.requests;
    },
    get connects() {
      return counts.connects;
    },
    /** Go offline and drop the open stream; resolves once the page saw it drop. */
    async cut(context: BrowserContext) {
      const dropsBefore = counts.drops;
      connectsAtCut = counts.connects;
      await context.setOffline(true);
      await page.evaluate(() => window.stop());
      await expect
        .poll(() => counts.drops, {
          timeout: 15_000,
          message: "the page never saw its event stream drop",
        })
        .toBeGreaterThan(dropsBefore);
    },
    /**
     * After `context.setOffline(false)`: the page opened a new stream. Nothing
     * can be answered while offline, so any connection counted after `cut` was
     * made once the outage ended.
     */
    async expectReconnected(timeout = 60_000) {
      if (connectsAtCut === undefined) throw new Error("expectReconnected() needs cut() first");
      const before = connectsAtCut;
      await expect
        .poll(() => counts.connects, { timeout, message: "the event stream never reconnected" })
        .toBeGreaterThan(before);
    },
  };
}

export type EventStreamWatch = ReturnType<typeof watchEventStream>;
