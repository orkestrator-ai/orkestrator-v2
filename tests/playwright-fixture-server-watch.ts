// Playwright watches its `webServer` only while it starts: in Playwright 1.65
// the process's exit rejects a promise that is raced against the startup URL
// check alone ("Process from config.webServer exited early"). An exit after
// that is not observed, so a component suite run whose Vite fixture server
// died partway carried on and failed every later case with
// `net::ERR_CONNECTION_REFUSED` (371 of one run's 447 failures, from to-do
// 8200, retired 2026-11-16).
//
// So the suite's global setup watches the server itself. It asks the fixture
// URL every ten seconds; after three refusals in a row it prints one line
// naming the server and stops the run the way Ctrl+C does, with a SIGINT to
// the runner's own PID. Playwright then stops the workers and the `webServer`,
// marks the rest "did not run" and exits 130 (interrupted).
//
// Only a definite failure counts: a refused or reset connection. A probe that
// gets no answer in time is inconclusive and neither counts nor clears the
// tally, so a server slowed by a loaded host does not end a healthy run. Any
// HTTP answer, whatever its status, means the server is up.

/** How often the fixture URL is asked. */
export const FIXTURE_SERVER_PROBE_INTERVAL_MS = 10_000;
/** Consecutive refusals that end the run: about 30 s after the server died. */
export const FIXTURE_SERVER_REFUSALS_BEFORE_STOP = 3;
/**
 * Overrides the probe interval in milliseconds. Only for tests of the watch
 * itself; a normal run uses the default.
 */
export const FIXTURE_SERVER_PROBE_INTERVAL_ENV = "ORKESTRATOR_E2E_FIXTURE_PROBE_MS";
/** Shortest interval the override accepts, so a typo cannot flood the server. */
const MIN_PROBE_INTERVAL_MS = 100;

export type FixtureProbeResult =
  { outcome: "up" } | { outcome: "refused"; detail: string } | { outcome: "inconclusive" };

/** The part of `process` the watch uses to stop the run. */
export interface InterruptTarget {
  readonly pid: number;
  listenerCount(event: "SIGINT"): number;
  kill(pid: number, signal: NodeJS.Signals): unknown;
}

export interface FixtureServerWatchOptions {
  url: string;
  intervalMs?: number;
  refusalsBeforeStop?: number;
  probe?: (url: string, timeoutMs: number) => Promise<FixtureProbeResult>;
  log?: (line: string) => void;
  target?: InterruptTarget;
  setInterval?: (callback: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export interface FixtureServerWatch {
  /** Stops probing. Safe to call more than once. */
  stop(): void;
  /** Why the watch stopped the run, once it has. */
  readonly stopReason: string | undefined;
}

/** Reads the interval override, falling back to the default. */
export function fixtureServerProbeIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[FIXTURE_SERVER_PROBE_INTERVAL_ENV];
  if (!raw) return FIXTURE_SERVER_PROBE_INTERVAL_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < MIN_PROBE_INTERVAL_MS) {
    throw new Error(
      `${FIXTURE_SERVER_PROBE_INTERVAL_ENV} must be a whole number of milliseconds of at least ${MIN_PROBE_INTERVAL_MS}; got ${JSON.stringify(raw)}.`,
    );
  }
  return parsed;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") return code;
  return errorCode((error as { cause?: unknown }).cause);
}

/** Sorts a failed request into a refusal or an inconclusive probe. */
export function classifyProbeError(error: unknown): FixtureProbeResult {
  const name = error && typeof error === "object" ? (error as { name?: unknown }).name : undefined;
  if (name === "TimeoutError" || name === "AbortError") return { outcome: "inconclusive" };
  const code = errorCode(error);
  // Node fetch wraps system errors in `cause`; Bun uses its own code names.
  // Resource exhaustion and unknown failures do not prove the server is down.
  if (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ConnectionRefused" ||
    code === "ConnectionReset"
  ) {
    return { outcome: "refused", detail: code };
  }
  return { outcome: "inconclusive" };
}

/** Asks the fixture URL once. The body is discarded unread. */
export async function probeFixtureServer(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<FixtureProbeResult> {
  try {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    });
    await response.body?.cancel().catch(() => {});
    return { outcome: "up" };
  } catch (error) {
    return classifyProbeError(error);
  }
}

/**
 * Starts the watch. Call it from the global setup of a config whose
 * `webServer` serves `url`, and call `stop()` from the setup's teardown.
 */
export function watchFixtureServer(options: FixtureServerWatchOptions): FixtureServerWatch {
  const intervalMs = options.intervalMs ?? FIXTURE_SERVER_PROBE_INTERVAL_MS;
  const refusalsBeforeStop = options.refusalsBeforeStop ?? FIXTURE_SERVER_REFUSALS_BEFORE_STOP;
  const probe = options.probe ?? probeFixtureServer;
  const log = options.log ?? ((line: string) => console.error(line));
  const target = options.target ?? (process as unknown as InterruptTarget);
  const startTimer =
    options.setInterval ??
    ((callback: () => void, ms: number) => {
      const handle = setInterval(callback, ms);
      // Never the reason the runner stays alive.
      handle.unref();
      return handle;
    });
  const stopTimer =
    options.clearInterval ??
    ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));

  let stopped = false;
  let inFlight = false;
  let refusals = 0;
  let stopReason: string | undefined;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    stopTimer(handle);
  };

  const onResult = (result: FixtureProbeResult) => {
    if (stopped) return;
    if (result.outcome === "up") {
      refusals = 0;
      return;
    }
    if (result.outcome === "inconclusive") return;
    refusals += 1;
    if (refusals < refusalsBeforeStop) return;
    stop();
    stopReason =
      `The fixture server at ${options.url} stopped answering ` +
      `(${result.detail}, ${refusals} probes ${intervalMs / 1000} s apart). ` +
      "Stopping the run: every case after this would fail with net::ERR_CONNECTION_REFUSED. " +
      "Its own output above says why it exited, if it printed anything.";
    log(stopReason);
    // Playwright listens for SIGINT only while a run is in progress. Without
    // a listener the signal would kill the runner outright, skipping the
    // teardown that stops the workers and the `webServer`, and by then the
    // run is ending anyway.
    if (target.listenerCount("SIGINT") > 0) target.kill(target.pid, "SIGINT");
  };

  const tick = () => {
    if (stopped || inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        // The probe's own deadline is one interval, so at most one is in flight.
        let result: FixtureProbeResult;
        try {
          result = await probe(options.url, intervalMs);
        } catch (error) {
          result = classifyProbeError(error);
        }
        onResult(result);
      } catch (error) {
        // An unhandled rejection would end the runner without its teardown.
        console.error("The fixture server watch failed:", error);
      } finally {
        inFlight = false;
      }
    })();
  };

  const handle = startTimer(tick, intervalMs);
  return {
    stop,
    get stopReason() {
      return stopReason;
    },
  };
}
