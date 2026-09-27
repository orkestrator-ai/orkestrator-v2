import { PUBLIC_API_LIMITS } from "@orkestrator/protocol/public-api";
import { CliError } from "./errors.js";

/**
 * Bounded snapshot polling. Checks immediately, then backs off from 250ms to
 * 2s. A deadline or a signal only stops *observing*: nothing here cancels
 * backend work, and the caller keeps the receipt to observe again later.
 */

export type ObservationStep<T> = { done: true; value: T } | { done: false };

export class ObservationStopped extends Error {
  constructor(
    readonly reason: "deadline" | "signal",
    readonly signalName?: "SIGINT" | "SIGTERM",
  ) {
    super(reason === "deadline" ? "Observation deadline passed" : "Observation interrupted");
  }
}

export interface ObserveOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Test hook. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export function signalName(signal: AbortSignal | undefined): "SIGINT" | "SIGTERM" {
  return signal?.reason === "SIGTERM" ? "SIGTERM" : "SIGINT";
}

export async function observe<T>(
  check: () => Promise<ObservationStep<T>>,
  options: ObserveOptions,
): Promise<T> {
  if (options.timeoutMs > PUBLIC_API_LIMITS.waitMaxMs) {
    throw new CliError("invalid-input", "--timeout may be at most 24h");
  }
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = now() + options.timeoutMs;
  let delay = 250;
  for (;;) {
    if (options.signal?.aborted) throw new ObservationStopped("signal", signalName(options.signal));
    const step = await check();
    if (step.done) return step.value;
    const remaining = deadline - now();
    if (remaining <= 0) throw new ObservationStopped("deadline");
    await sleep(Math.min(delay, remaining), options.signal);
    delay = Math.min(delay * 2, 2_000);
  }
}
