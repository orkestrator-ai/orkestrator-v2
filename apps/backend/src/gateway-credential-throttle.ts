import { createHmac, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { createLogger } from "@orkestrator/protocol/logger";
import { isLoopbackAddress, tokenMatches } from "./gateway-internals.js";

const log = createLogger("gateway");

/** Wrong values a listener answers before it starts to slow down. */
export const FREE_WRONG_GUESSES = 10;
/** The first pause; each further wrong value doubles it, up to the cap. */
export const FIRST_PAUSE_MS = 1_000;
export const MAX_PAUSE_MS = 60_000;
/** A listener that sees no new wrong value for this long starts again. */
export const GUESS_MEMORY_MS = 15 * 60_000;
/** Bounds on what is remembered; both are forgotten oldest first. */
export const MAX_REMEMBERED_GUESSES = 256;
export const MAX_PROVEN_PEERS = 64;

export type GuessOutcome = "match" | "wrong" | "throttled";

/** The part of a request that identifies who is asking. */
export type GuessPeer = Pick<IncomingMessage, "socket">;

interface ListenerGuesses {
  wrong: number;
  lastWrongAt: number;
  pausedUntil: number;
  /** Keyed digests of wrong values, so no candidate credential stays in memory. */
  remembered: Set<string>;
}

/**
 * Slows guessing of the durable gateway token, which a user may choose as short
 * as 16 characters. Sessions and grants are random and never come through here.
 *
 * While paused a new value is not compared at all, and the correct token is
 * refused like any other. It cannot be otherwise: if the right token still
 * passed, a guesser would simply read the answer off the one that succeeds and
 * the pause would slow nothing. That costs a real client something only until
 * it has proven itself, so what stays exempt during a pause is:
 *
 * - A connection that has already presented the token, which is how an open
 *   client keeps working.
 * - A non-loopback address that has presented it. Loopback is everyone behind
 *   Tailscale Serve, and a Docker Desktop container, so it proves nothing.
 *
 * Three more choices keep a guesser or a stale client from locking people out:
 *
 * - Only a value not seen before counts. A client still sending a token from
 *   before a rotation is not guessing, repeats no new information, and keeps
 *   getting the 401 it always got.
 * - Each listener counts on its own, so guessing through the browser listener
 *   never touches the desktop app's control listener.
 * - A later success does not clear the count, or a real client's traffic would
 *   keep resetting a guesser's pause.
 */
export class GatewayCredentialThrottle {
  private readonly digestKey = randomBytes(32);
  private readonly listeners = new Map<number, ListenerGuesses>();
  private provenSockets = new WeakSet<object>();
  private readonly provenPeers = new Set<string>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Compares `candidate` with `token` unless this listener is paused for this peer. */
  check(token: string, candidate: string, peer: GuessPeer): GuessOutcome {
    const key = peer.socket.localPort ?? 0;
    const guesses = this.guessesFor(key);
    const digest = createHmac("sha256", this.digestKey).update(candidate).digest("base64");
    if (guesses?.remembered.has(digest)) return "wrong";
    if (guesses && guesses.pausedUntil > this.now() && !this.proven(peer)) return "throttled";
    if (tokenMatches(token, candidate)) {
      this.noteProven(peer);
      return "match";
    }
    this.noteWrong(key, guesses, digest);
    return "wrong";
  }

  /** Whole seconds until this listener compares a new value again, at least 1. */
  retryAfterSeconds(peer: GuessPeer): number {
    const pausedUntil = this.listeners.get(peer.socket.localPort ?? 0)?.pausedUntil ?? 0;
    return Math.max(1, Math.ceil((pausedUntil - this.now()) / 1000));
  }

  /** A rotated token makes every remembered value and every proof meaningless. */
  reset(): void {
    this.listeners.clear();
    this.provenSockets = new WeakSet();
    this.provenPeers.clear();
  }

  private guessesFor(key: number): ListenerGuesses | undefined {
    const guesses = this.listeners.get(key);
    if (guesses && this.now() - guesses.lastWrongAt >= GUESS_MEMORY_MS) {
      this.listeners.delete(key);
      return undefined;
    }
    return guesses;
  }

  private noteWrong(key: number, existing: ListenerGuesses | undefined, digest: string): void {
    const guesses = existing ?? { wrong: 0, lastWrongAt: 0, pausedUntil: 0, remembered: new Set() };
    this.listeners.set(key, guesses);
    guesses.remembered.add(digest);
    if (guesses.remembered.size > MAX_REMEMBERED_GUESSES) {
      const oldest = guesses.remembered.values().next().value as string;
      guesses.remembered.delete(oldest);
    }
    guesses.wrong += 1;
    guesses.lastWrongAt = this.now();
    const over = guesses.wrong - FREE_WRONG_GUESSES;
    if (over <= 0) return;
    guesses.pausedUntil = this.now() + Math.min(MAX_PAUSE_MS, FIRST_PAUSE_MS * 2 ** (over - 1));
    if (over === 1) log.warn("auth-guess.throttled", { port: key, wrong: guesses.wrong });
  }

  private proven(peer: GuessPeer): boolean {
    if (this.provenSockets.has(peer.socket)) return true;
    const address = peerAddress(peer);
    return address !== null && this.provenPeers.has(address);
  }

  private noteProven(peer: GuessPeer): void {
    this.provenSockets.add(peer.socket);
    const address = peerAddress(peer);
    if (address === null) return;
    // Re-adding moves it to the end, so the oldest is the one forgotten.
    this.provenPeers.delete(address);
    this.provenPeers.add(address);
    if (this.provenPeers.size > MAX_PROVEN_PEERS) {
      const oldest = this.provenPeers.values().next().value as string;
      this.provenPeers.delete(oldest);
    }
  }
}

/** The peer's address when it can identify a client, which loopback cannot. */
function peerAddress(peer: GuessPeer): string | null {
  const address = peer.socket.remoteAddress?.replace(/^::ffff:/, "");
  return address && !isLoopbackAddress(address) ? address : null;
}
