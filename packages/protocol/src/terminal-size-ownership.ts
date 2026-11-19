/**
 * Who sets a shared terminal's dimensions.
 *
 * Several clients can show one terminal session at once: a desktop window, a
 * browser, a phone. Each fits the terminal to its own pane and reports the
 * result, so without a rule every client's layout change resizes the PTY that
 * all of them share. The backend therefore keeps one *size owner* per session
 * (`apps/backend/src/core/terminal-size-ownership.ts`):
 *
 * - A **claim** (`claim_terminal_size`) comes from deliberate interaction
 *   with the terminal: focusing it, clicking or tapping it, typing in it. It
 *   makes the caller the owner and applies its dimensions.
 * - An **update** (`terminal_resize`, `local_terminal_resize`, the terminal
 *   WebSocket's `resize` frame) comes from passive layout: a window resize, a
 *   phone rotating, a pane opening. It applies only when the caller already
 *   owns the size, or when nobody does, in which case the caller becomes the
 *   owner.
 *
 * Every client still receives the terminal's output; only the PTY's geometry
 * is owned. A client identifies itself with an opaque `clientId` that it keeps
 * for the life of its window. A resize without one comes from an older client:
 * it is treated as an update from a client that can never own the size, so it
 * applies only while nobody owns it, which is what every resize did before.
 *
 * Browser-safe.
 */

/** Longest `clientId` the backend accepts; a longer one reads as absent. */
export const TERMINAL_SIZE_CLIENT_ID_MAX_CHARS = 128;

const CLIENT_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

/**
 * The client id carried by a resize, or null when there is none or it is not
 * a usable id. Never throws: a malformed id must not cost the user a resize.
 */
export function parseTerminalSizeClientId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > TERMINAL_SIZE_CLIENT_ID_MAX_CHARS) return null;
  return CLIENT_ID_PATTERN.test(value) ? value : null;
}

/**
 * How often typing re-claims the size. The first keystroke after another
 * client took the terminal over takes it back; later keystrokes in the same
 * burst do not each send a resize.
 */
export const TERMINAL_SIZE_INPUT_CLAIM_INTERVAL_MS = 5_000;
