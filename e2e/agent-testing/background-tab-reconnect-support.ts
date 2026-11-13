import type { ChildProcess } from "node:child_process";
import type { LinkRequest, LinkRequestKind } from "./client-outage-support";

/**
 * Pieces of `background-tab-reconnect-live.spec.ts` that do not need a
 * display: the headed browser's exception-safe startup and the timing rules
 * the spec asserts. The spec is opt-in, so these are what the default suite
 * can prove about it (`background-tab-reconnect-support.test.ts`).
 */

/** Chromium silently resends a request that died on a reused idle socket. */
export const NETWORK_RESEND_MS = 100;

/** The streams whose reconnect a visibility edge must trigger. */
export const RETRY_STREAMS = ["main-stream", "terminal-stream"] as const;
export type RetryStream = (typeof RETRY_STREAMS)[number];

/** Distinct attempts of one kind in `[since, until)`, resends folded into the first. */
export function distinctAttempts(
  requests: readonly LinkRequest[],
  kind: LinkRequestKind,
  since: number,
  until = Infinity,
): number[] {
  return requests
    .filter((request) => request.kind === kind && request.at >= since && request.at < until)
    .map((request) => request.at)
    .filter((at, index, times) => index === 0 || at - times[index - 1]! > NETWORK_RESEND_MS);
}

/**
 * Whether every retry stream's latest attempt since `since` happened within
 * `windowMs` before `now`. During an outage each attempt fails, so when this
 * holds every stream has just failed and its ladder's next rung is at least
 * a capped rung's floor away.
 */
export function latestFailures(
  requests: readonly LinkRequest[],
  since: number,
  now: number,
  windowMs: number,
): Record<RetryStream, number> | null {
  const latest = {} as Record<RetryStream, number>;
  for (const kind of RETRY_STREAMS) {
    const at = distinctAttempts(requests, kind, since).at(-1);
    if (at === undefined || now - at > windowMs) return null;
    latest[kind] = at;
  }
  return latest;
}

export interface StreamVisibleRetry {
  /** Visibility edge minus the stream's last failed attempt before it. */
  lastFailureBeforeVisibleMs: number;
  /** Attempts after the link returned and before the tab was shown: ladder rungs. */
  attemptsBeforeVisible: number;
  /** First attempt after the link returned, relative to the visibility edge. */
  retryAfterVisibleMs: number | null;
}

export interface VisibleRetryCheck {
  streams: Record<RetryStream, StreamVisibleRetry>;
  /** Every rule the evidence breaks; empty when the retry was the visibility edge's. */
  violations: string[];
}

/**
 * The visible-retry rules. A retry counts as the visibility edge's only when,
 * for every stream: its last failure was recent enough that the ladder's next
 * rung was still far off, no attempt happened between the link returning and
 * the tab being shown, and the first attempt came at or after the edge and
 * within the budget.
 */
export function checkVisibleRetry(input: {
  requests: readonly LinkRequest[];
  lastFailures: Record<RetryStream, number>;
  restoredAt: number;
  visibleAt: number;
  rungFloorMs: number;
  /** Margin kept below the rung floor for the time it takes to show the tab. */
  rungMarginMs: number;
  budgetMs: number;
}): VisibleRetryCheck {
  const violations: string[] = [];
  const streams = {} as Record<RetryStream, StreamVisibleRetry>;
  for (const kind of RETRY_STREAMS) {
    const lastFailureBeforeVisibleMs = input.visibleAt - input.lastFailures[kind];
    const attemptsBeforeVisible = distinctAttempts(
      input.requests,
      kind,
      input.restoredAt,
      input.visibleAt,
    ).length;
    const retryAt = distinctAttempts(input.requests, kind, input.restoredAt)[0];
    const retryAfterVisibleMs = retryAt === undefined ? null : retryAt - input.visibleAt;
    streams[kind] = { lastFailureBeforeVisibleMs, attemptsBeforeVisible, retryAfterVisibleMs };
    if (lastFailureBeforeVisibleMs >= input.rungFloorMs - input.rungMarginMs) {
      violations.push(`${kind}: the ladder's next rung may have been due when the tab was shown`);
    }
    if (attemptsBeforeVisible > 0) {
      violations.push(`${kind}: attempted before the tab was shown`);
    }
    if (retryAfterVisibleMs === null) {
      violations.push(`${kind}: no retry after the tab was shown`);
    } else if (retryAfterVisibleMs < 0) {
      violations.push(`${kind}: retried before the tab was shown`);
    } else if (retryAfterVisibleMs > input.budgetMs) {
      violations.push(`${kind}: retried ${retryAfterVisibleMs} ms after shown`);
    }
  }
  return { streams, violations };
}

/** Ends a child this test spawned, through its own handle, and waits for it. */
export async function terminateChild(child: ChildProcess, graceMs = 10_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const timer = { handle: undefined as ReturnType<typeof setTimeout> | undefined };
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise<boolean>((resolve) => {
      timer.handle = setTimeout(() => resolve(false), graceMs);
    }),
  ]);
  clearTimeout(timer.handle);
  if (graceful) return;
  child.kill("SIGKILL");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, graceMs))]);
}

/**
 * Waits for the DevTools endpoint a spawned Chromium prints, then attaches.
 * Any failure on the way (a spawn error, an early exit, no endpoint in time, a
 * refused attachment) terminates the child and waits for it before rejecting,
 * so the caller never inherits a browser it has no handle on.
 */
export async function attachToSpawnedBrowser<B>(
  child: ChildProcess,
  connect: (endpoint: string) => Promise<B>,
  startupTimeoutMs = 30_000,
): Promise<B> {
  // A later spawn or kill error must not crash the runner: startup reports
  // the first one, and the owner's cleanup handles the process afterwards.
  child.on("error", () => undefined);
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      let output = "";
      const settle = (outcome: () => void) => {
        clearTimeout(timer);
        child.off("error", onError);
        child.off("exit", onExit);
        child.stderr?.off("data", onData);
        outcome();
      };
      const onError = (error: Error) => settle(() => reject(error));
      const onExit = () => settle(() => reject(new Error("Chromium exited before it was ready")));
      const onData = (chunk: Buffer) => {
        // Bounded: only the first lines carry the endpoint.
        if (output.length < 64 * 1024) output += chunk.toString("utf8");
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(output);
        if (match) settle(() => resolve(match[1]!));
      };
      const timer = setTimeout(
        () => settle(() => reject(new Error("Chromium printed no DevTools endpoint"))),
        startupTimeoutMs,
      );
      child.once("error", onError);
      child.once("exit", onExit);
      if (!child.stderr) {
        settle(() => reject(new Error("Chromium was spawned without a stderr pipe")));
        return;
      }
      child.stderr.on("data", onData);
    });
    // Keep draining stderr so a chatty browser never blocks on a full pipe.
    child.stderr?.resume();
    return await connect(endpoint);
  } catch (error) {
    await terminateChild(child);
    throw error;
  }
}
