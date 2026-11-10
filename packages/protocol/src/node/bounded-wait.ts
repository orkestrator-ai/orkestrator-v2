/**
 * Wait for a promise for at most a fixed time, without cancelling it.
 *
 * The bridges bound every wait on somebody else's process or server: catalogue
 * and history reads, credential probes, close acknowledgements, MCP connects.
 * Each used to carry its own "timer, race, `finally clearTimeout`" copy, and the
 * copies drifted on two points this helper fixes once:
 *
 * - The timer is unref'd, so a pending wait never holds the process open, and
 *   it is cleared as soon as the work settles first.
 * - The work keeps running after the wait gives up. A late rejection is always
 *   observed (under Bun an unhandled rejection is fatal), and a late value is
 *   handed to `onLate` so the caller can dispose it (close a late connection
 *   or handle) instead of leaking it.
 *
 * A rejection that arrives before the deadline propagates unchanged.
 *
 * Effect-free on purpose: the bridges carry no Effect runtime
 * (docs/development/effect-usage.md).
 */

export type BoundedWaitResult<T> =
  { readonly settled: true; readonly value: T } | { readonly settled: false };

export interface BoundedWaitOptions<T> {
  /**
   * Called once with the value when the work resolves after the wait gave up.
   * Use it to dispose a late result. A throw or a rejected promise from it is
   * observed and dropped.
   */
  readonly onLate?: (value: T) => unknown;
}

/**
 * Wait for `work` for at most `timeoutMs`. Resolves `{ settled: true, value }`
 * when it resolves in time and `{ settled: false }` when the time runs out
 * first; rejects with the work's own error when it rejects in time.
 */
export function boundedWait<T>(
  work: PromiseLike<T>,
  timeoutMs: number,
  options: BoundedWaitOptions<T> = {},
): Promise<BoundedWaitResult<T>> {
  return new Promise<BoundedWaitResult<T>>((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      resolve({ settled: false });
    }, timeoutMs);
    unrefTimer(timer);
    Promise.resolve(work).then(
      (value) => {
        if (!timedOut) {
          clearTimeout(timer);
          resolve({ settled: true, value });
          return;
        }
        disposeLate(options.onLate, value);
      },
      (error: unknown) => {
        if (!timedOut) {
          clearTimeout(timer);
          reject(error);
        }
        // A late rejection is observed here and dropped: nobody is waiting.
      },
    );
  });
}

/**
 * {@link boundedWait} for callers that treat running out of time as a failure:
 * resolves with the work's value, or rejects with `timeoutError()` when the
 * time runs out first.
 */
export async function boundedWaitOrThrow<T>(
  work: PromiseLike<T>,
  timeoutMs: number,
  timeoutError: () => unknown,
  options: BoundedWaitOptions<T> = {},
): Promise<T> {
  const result = await boundedWait(work, timeoutMs, options);
  if (!result.settled) throw timeoutError();
  return result.value;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  // Node and Bun return a Timeout with `unref`; a browser-like runtime a number.
  const handle = timer as { unref?: () => unknown } | number;
  if (typeof handle === "object" && typeof handle.unref === "function") handle.unref();
}

function disposeLate<T>(onLate: BoundedWaitOptions<T>["onLate"], value: T): void {
  if (!onLate) return;
  try {
    const disposal = onLate(value);
    if (disposal && typeof (disposal as PromiseLike<unknown>).then === "function") {
      Promise.resolve(disposal).catch(() => undefined);
    }
  } catch {
    // Disposing a result nobody is waiting for must not throw into the void.
  }
}
