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

function readDebugFlag(): boolean {
  const raw = process.env.CLAUDE_BRIDGE_DEBUG?.trim().toLowerCase();
  if (!raw) return false;
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

/**
 * Read once at module load. A per-call `process.env` lookup is itself
 * measurable at token frequency, and the flag is not meant to be toggled
 * mid-process.
 */
export const isDebugLoggingEnabled: boolean = readDebugFlag();

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
