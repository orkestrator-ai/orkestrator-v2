import type { SshAdapterContext } from "./context.js";
import { isForwardingDeniedLine } from "./stderr-classification.js";
import type { OwnedSshChild } from "./tunnel-child.js";

export const TUNNEL_READY_TIMEOUT_MS = 15_000;
const INITIAL_POLL_MS = 25;
const MAX_POLL_MS = 250;
/** Time for ssh to write a channel-open verdict after the probe connection. */
const STDERR_SETTLE_MS = 50;

export type ReadinessOutcome =
  | { ready: true }
  | { ready: false; reason: "exited" | "forwarding-denied" | "timeout" | "cancelled" };

const AUTHENTICATED = /^Authenticated to /m;

function hasForwardingDenied(stderr: string): boolean {
  return stderr.split(/\r?\n/).some(isForwardingDeniedLine);
}

/**
 * Forward readiness, not application health. The forward is ready when:
 * 1. ssh logged (LogLevel=VERBOSE) that user authentication finished, after
 *    which it binds the `-L` listener synchronously;
 * 2. the local port accepts a TCP connection while the child is still alive;
 * 3. after that probe connection ssh did not report the channel as
 *    administratively prohibited (SH-07) and did not exit (SH-05 bind loss).
 *
 * Waiting for (1) first means an unrelated listener that grabbed the port is
 * never mistaken for the forward. A remote "connect failed" on the probe
 * channel (SH-06) still counts as ready: the caller's authenticated hello is
 * what decides whether the gateway is healthy.
 *
 * Time spent with an askpass prompt open does not count toward the deadline.
 */
export async function waitForTunnelReady(
  context: SshAdapterContext,
  child: OwnedSshChild,
  input: {
    localPort: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    promptActive?: () => boolean;
  },
): Promise<ReadinessOutcome> {
  let deadline = context.clock.now() + (input.timeoutMs ?? TUNNEL_READY_TIMEOUT_MS);
  let lastTick = context.clock.now();
  let delay = INITIAL_POLL_MS;
  for (;;) {
    if (input.signal?.aborted) return { ready: false, reason: "cancelled" };
    if (!child.alive) return { ready: false, reason: "exited" };
    if (hasForwardingDenied(child.stderr)) return { ready: false, reason: "forwarding-denied" };

    if (AUTHENTICATED.test(child.stderr)) {
      const probe = await context.probeForward(input.localPort, input.signal);
      if (input.signal?.aborted) return { ready: false, reason: "cancelled" };
      if (probe !== "refused") {
        await context.clock.sleep(STDERR_SETTLE_MS, input.signal);
        if (input.signal?.aborted) return { ready: false, reason: "cancelled" };
        if (!child.alive) return { ready: false, reason: "exited" };
        if (hasForwardingDenied(child.stderr)) {
          return { ready: false, reason: "forwarding-denied" };
        }
        return { ready: true };
      }
    }

    const now = context.clock.now();
    if (input.promptActive?.()) deadline += now - lastTick;
    lastTick = now;
    if (now >= deadline) return { ready: false, reason: "timeout" };
    await context.clock.sleep(Math.min(delay, Math.max(1, deadline - now)), input.signal);
    delay = Math.min(delay * 2, MAX_POLL_MS);
  }
}
