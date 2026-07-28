// Debug logging gate for the Claude bridge.
//
// The streaming path runs at token frequency: with `includePartialMessages`
// the SDK emits a `stream_event` per delta, and every emitted SSE frame goes
// through the event emitter. Logging unconditionally on those paths costs a
// write syscall per token, and in local mode the backend pipes the bridge's
// stdout straight back into its own logger, so each line is paid for twice
// across two processes. In Docker mode it accumulates in an unrotated
// /tmp/claude-bridge.log.
//
// Hot-path diagnostics therefore go through `debugLog`, which is off unless
// explicitly enabled. Anything that fires at most once per turn can keep using
// `console.log`/`console.error` directly.

import { logger as honoLogger } from "hono/logger";
import type { MiddlewareHandler } from "hono";

/**
 * Interpret `CLAUDE_BRIDGE_DEBUG`.
 *
 * Any value enables debug logging except the conventional "off" spellings, so
 * `CLAUDE_BRIDGE_DEBUG=0` in a shell profile does not silently turn it on.
 * Exported so the parsing can be tested without re-importing this module under
 * a mutated environment.
 */
export function readDebugFlag(env: string | undefined): boolean {
  const raw = env?.trim().toLowerCase();
  if (!raw) return false;
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

/**
 * Read once at module load. A per-call `process.env` lookup is itself
 * measurable at token frequency, and the flag is not meant to be toggled
 * mid-process.
 */
export const isDebugLoggingEnabled: boolean = readDebugFlag(process.env.CLAUDE_BRIDGE_DEBUG);

/**
 * Log only when `CLAUDE_BRIDGE_DEBUG` is set.
 *
 * Callers must pass already-cheap arguments, or guard construction with
 * `isDebugLoggingEnabled` — the point is to avoid the work, not just the
 * write. Building a throwaway object literal per token still allocates even
 * when this function discards it.
 */
export function debugLog(...args: unknown[]): void {
  if (!isDebugLoggingEnabled) return;
  console.debug(...args);
}

/** Remove EventSource credentials before a request line reaches any log sink. */
export function redactRequestLogMessage(message: string): string {
  return message.replace(/([?&]token=)[^&\s]+/gi, "$1<redacted>");
}

/**
 * Hono's per-request logging middleware, or null when debug logging is off.
 *
 * Request logging is debug-only. In Docker the bridge's stdout is an unrotated
 * /tmp/claude-bridge.log, and in local mode the backend re-logs every line it
 * reads, so per-request noise is paid for twice for no routine benefit.
 *
 * Takes the flag as an argument so both branches are reachable from a test;
 * production callers use the module-load default.
 */
export function createRequestLogger(
  enabled: boolean = isDebugLoggingEnabled,
  write: (message: string, ...rest: string[]) => void = console.log,
): MiddlewareHandler | null {
  return enabled
    ? honoLogger((message, ...rest) => {
        write(
          redactRequestLogMessage(message),
          ...rest.map(redactRequestLogMessage),
        );
      })
    : null;
}
