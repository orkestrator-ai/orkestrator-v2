/**
 * This window's identity for shared terminal sizing
 * (`@orkestrator/protocol/terminal-size-ownership`).
 *
 * One id per window, kept in `sessionStorage` so a reload is still the same
 * client: a reloaded window that came back as a stranger would find its own
 * previous self owning the size and have every resize refused until the user
 * clicked the terminal. A new window, or a second tab, gets a new id.
 */
import {
  parseTerminalSizeClientId,
  TERMINAL_SIZE_INPUT_CLAIM_INTERVAL_MS,
} from "@orkestrator/protocol/terminal-size-ownership";

const STORAGE_KEY = "orkestrator:terminal-size-client-id";

let cachedClientId: string | null = null;

function newClientId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function readStoredClientId(): string | null {
  try {
    return parseTerminalSizeClientId(globalThis.sessionStorage?.getItem(STORAGE_KEY));
  } catch {
    // Storage can be unavailable (privacy modes, sandboxed frames).
    return null;
  }
}

function storeClientId(clientId: string): void {
  try {
    globalThis.sessionStorage?.setItem(STORAGE_KEY, clientId);
  } catch {
    // The id then lasts as long as this page does, which is still correct.
  }
}

/** This window's terminal sizing client id. */
export function terminalSizeClientId(): string {
  if (cachedClientId) return cachedClientId;
  const clientId = readStoredClientId() ?? newClientId();
  storeClientId(clientId);
  cachedClientId = clientId;
  return clientId;
}

/** Tests only: forget the cached id so the next call reads storage again. */
export function resetTerminalSizeClientIdForTests(): void {
  cachedClientId = null;
}

/**
 * Throttles the claims typing makes: true when this keystroke should claim,
 * which is the first one after `TERMINAL_SIZE_INPUT_CLAIM_INTERVAL_MS` without
 * a claim. Any other claim (focus, a click) resets the interval through
 * `noteClaim`.
 */
export class TerminalInputClaimThrottle {
  private lastClaimAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly intervalMs = TERMINAL_SIZE_INPUT_CLAIM_INTERVAL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  shouldClaim(): boolean {
    const now = this.now();
    if (now - this.lastClaimAt < this.intervalMs) return false;
    this.lastClaimAt = now;
    return true;
  }

  noteClaim(): void {
    this.lastClaimAt = this.now();
  }
}
