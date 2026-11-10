/**
 * One bounded-wait helper, shared by every off-turn read this bridge makes.
 *
 * Catalogue reads, history reads and credential probes all talk to somebody
 * else's process or server, so each of them needs a ceiling. The wait itself is
 * the shared `boundedWait`, which unrefs its timer (a ref'd timer here would
 * hold the event loop open and stop the bridge exiting) and observes a late
 * rejection; this keeps the bridge's own `TimeoutError` callers test for.
 */
import { boundedWaitOrThrow } from "@orkestrator/protocol/node/bounded-wait";

export class TimeoutError extends Error {
  override readonly name = "TimeoutError";
}

export function withTimeout<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return boundedWaitOrThrow(work, timeoutMs, () => new TimeoutError(message));
}
