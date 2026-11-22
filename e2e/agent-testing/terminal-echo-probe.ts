import type { Page } from "@playwright/test";

export const KEY_GAP_MS = 30;
export const KEY_PHASE_SPREAD_MS = 1000 / 60;

/** Spread the gaps over one 60 Hz frame using a golden-ratio sequence. */
export function keyPhaseOffsetMs(index: number): number {
  return ((index * 0.618_033_988_75) % 1) * KEY_PHASE_SPREAD_MS;
}

export function waitBetweenKeys(page: Page, index: number) {
  return page.waitForTimeout(KEY_GAP_MS + keyPhaseOffsetMs(index));
}

type Echo = { keyAt: number | null; echoAt: number | null; keyPhaseMs: number | null };
type Probe = {
  arm(suffix: string, key: string): void;
  wait(timeoutMs: number): Promise<Echo>;
  reset(): void;
  finish(): {
    endedAt: number;
    frameGaps: number[];
    longTasks: number;
    longTaskMs: number;
    longestTaskMs: number;
  };
  requests(timeoutMs: number): Promise<{
    samples: Record<string, number[]>;
    counts: {
      matched: number;
      missingWrite: number;
      ambiguousWrite: number;
      missingTiming: number;
    };
  }>;
  stop(): void;
};

declare global {
  interface Window {
    __echoProbe?: Probe;
  }
}

/** The browser observes keydowns and echoes without involving the Playwright worker. */
export async function installProbe(page: Page, tabId: string, sessionId: string) {
  await page.evaluate(
    ({ tabId, sessionId }) => {
      type Write = { url: string; sentAt: number };
      type Armed = Echo & { suffix: string; key: string; writes: Write[] };
      const host = document.querySelector(`[data-terminal-tab-id="${tabId}"]`);
      const rows = host?.querySelector(".xterm-rows");
      if (!host || !rows) throw new Error("typing terminal not found");
      window.__echoProbe?.stop();
      let armed: Armed | null = null;
      const keys: Armed[] = [];
      let resolve: (() => void) | null = null;
      let nextWriteId = 0;
      let lastFrame: number | undefined;
      let previousFrame: number | undefined;
      let frameId: number;
      const frameGaps: number[] = [];
      const longTasks: number[] = [];
      const frame = (at: number) => {
        if (lastFrame !== undefined) frameGaps.push(at - lastFrame);
        previousFrame = lastFrame;
        lastFrame = at;
        frameId = requestAnimationFrame(frame);
      };
      frameId = requestAnimationFrame(frame);

      const check = () => {
        if (!armed || armed.echoAt !== null || armed.keyAt === null) return;
        const text = Array.from(rows.children)
          .map((row) => row.textContent ?? "")
          .join("")
          .trimEnd();
        if (text.endsWith(armed.suffix)) {
          armed.echoAt = performance.now();
          resolve?.();
        }
      };
      const onKey = (event: KeyboardEvent) => {
        if (!armed || armed.keyAt !== null || event.key !== armed.key) return;
        armed.keyAt = event.timeStamp;
        const priorFrame =
          lastFrame !== undefined && lastFrame <= event.timeStamp ? lastFrame : previousFrame;
        if (priorFrame !== undefined && priorFrame <= event.timeStamp) {
          armed.keyPhaseMs = event.timeStamp - priorFrame;
        }
      };
      host.addEventListener("keydown", onKey as EventListener, { capture: true });
      const observer = new MutationObserver(check);
      observer.observe(rows, { childList: true, subtree: true, characterData: true });
      const recordTasks = (entries: PerformanceEntry[]) => {
        for (const entry of entries) longTasks.push(entry.duration);
      };
      let longTaskObserver: PerformanceObserver | undefined;
      if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
        longTaskObserver = new PerformanceObserver((list) => recordTasks(list.getEntries()));
        longTaskObserver.observe({ type: "longtask" });
      }

      // Give a matching POST its own Resource Timing name. The gateway routes by
      // pathname. The query carries only a synthetic ordinal, including on retries.
      const originalFetch = window.fetch;
      window.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
        if (
          armed?.keyAt != null &&
          armed.writes.length < 2 &&
          (typeof input === "string" || input instanceof URL) &&
          String(input).includes("/__orkestrator/invoke") &&
          init?.method === "POST" &&
          typeof init.body === "string"
        ) {
          const sentAt = performance.now();
          const url = new URL(input, location.href);
          if (url.pathname === "/__orkestrator/invoke") {
            let payload: { command?: string; args?: { sessionId?: string; data?: string } } | null;
            try {
              payload = JSON.parse(init.body);
            } catch {
              payload = null;
            }
            if (
              (payload?.command === "local_terminal_write" ||
                payload?.command === "terminal_write") &&
              payload.args?.sessionId === sessionId &&
              payload.args.data === armed.key
            ) {
              url.searchParams.set("echoProbe", String(++nextWriteId));
              armed.writes.push({ url: url.href, sentAt });
              return originalFetch(url.href, init);
            }
          }
        }
        return originalFetch(input, init);
      }, originalFetch);
      performance.setResourceTimingBufferSize(100_000);
      performance.clearResourceTimings();

      const echo = () => ({
        keyAt: armed?.keyAt ?? null,
        echoAt: armed?.echoAt ?? null,
        keyPhaseMs: armed?.keyPhaseMs ?? null,
      });
      const stopObservers = () => {
        observer.disconnect();
        longTaskObserver?.disconnect();
        host.removeEventListener("keydown", onKey as EventListener, { capture: true });
        cancelAnimationFrame(frameId);
      };
      window.__echoProbe = {
        arm(suffix, key) {
          armed = { suffix, key, keyAt: null, echoAt: null, keyPhaseMs: null, writes: [] };
          keys.push(armed);
        },
        wait(timeoutMs) {
          if (armed?.echoAt != null) return Promise.resolve(echo());
          return new Promise((done) => {
            const finish = () => {
              clearTimeout(timer);
              resolve = null;
              done(echo());
            };
            const timer = setTimeout(finish, timeoutMs);
            resolve = finish;
            check();
          });
        },
        reset() {
          keys.length = 0;
          armed = null;
          frameGaps.length = 0;
          longTasks.length = 0;
          longTaskObserver?.takeRecords();
          performance.clearResourceTimings();
        },
        finish() {
          const end = armed?.echoAt ?? performance.now();
          if (longTaskObserver) recordTasks(longTaskObserver.takeRecords());
          stopObservers();
          return {
            endedAt: performance.timeOrigin + end,
            frameGaps,
            longTasks: longTasks.length,
            longTaskMs: Math.round(longTasks.reduce((sum, value) => sum + value, 0)),
            longestTaskMs: Math.round(Math.max(0, ...longTasks)),
          };
        },
        async requests(timeoutMs) {
          const samples: Record<string, number[]> = {
            sent: [],
            start: [],
            queued: [],
            server: [],
            duration: [],
            echoAfterStart: [],
          };
          const counts = { matched: 0, missingWrite: 0, ambiguousWrite: 0, missingTiming: 0 };
          const entryFor = (url: string) =>
            performance.getEntriesByName(url, "resource")[0] as
              PerformanceResourceTiming | undefined;
          const deadline = performance.now() + timeoutMs;
          while (
            performance.now() < deadline &&
            keys.some(({ writes }) => writes.length === 1 && !entryFor(writes[0]!.url))
          ) {
            await new Promise((done) => setTimeout(done, 20));
          }
          for (const { keyAt, echoAt, writes } of keys) {
            if (keyAt === null || writes.length === 0) {
              counts.missingWrite++;
              continue;
            }
            if (writes.length > 1) {
              counts.ambiguousWrite++;
              continue;
            }
            const write = writes[0]!;
            samples.sent!.push(write.sentAt - keyAt);
            const entry = entryFor(write.url);
            if (!entry?.requestStart || !entry.responseStart) {
              counts.missingTiming++;
              continue;
            }
            counts.matched++;
            samples.start!.push(entry.startTime - keyAt);
            samples.queued!.push(entry.requestStart - entry.startTime);
            samples.server!.push(entry.responseStart - entry.requestStart);
            samples.duration!.push(entry.duration);
            if (echoAt !== null) samples.echoAfterStart!.push(echoAt - entry.startTime);
          }
          return { samples, counts };
        },
        stop() {
          window.fetch = originalFetch;
          stopObservers();
          delete window.__echoProbe;
        },
      };
    },
    { tabId, sessionId },
  );
}

/** Freeze the typing window before capture export or the bounded network drain. */
export async function finishProbeMeasurement(page: Page, exportCapture?: () => Promise<void>) {
  const windowStats = await page.evaluate(() => window.__echoProbe!.finish());
  const exportStartedAt = performance.now();
  await exportCapture?.();
  const profileExportMs = exportCapture ? performance.now() - exportStartedAt : null;
  const requests = await page.evaluate(() => window.__echoProbe!.requests(2_000));
  return { ...windowStats, profileExportMs, requests };
}

export function streamCoveredTypingWindow(
  call: { answeredAt?: number; streamedAt?: number; aborted?: boolean },
  startedAt: number,
  endedAt: number,
) {
  return (
    call.answeredAt !== undefined &&
    call.answeredAt <= startedAt &&
    !call.aborted &&
    (call.streamedAt === undefined || call.streamedAt >= endedAt)
  );
}
