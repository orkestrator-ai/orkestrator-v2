/**
 * One size owner per shared terminal session.
 *
 * The rule (claim versus update) is described in
 * `@orkestrator/protocol/terminal-size-ownership`. This module decides each
 * resize; the resize handlers in `commands-registry-terminal.ts` apply the
 * PTY change only when it says so.
 *
 * An owner holds a lease rather than holding the size forever, because most
 * clients have no connection the backend can watch: a window that crashes, or
 * a phone that sleeps over plain HTTP, never says goodbye.
 *
 * - Every accepted resize or claim from the owner renews the lease.
 * - A client releases its ownership when its terminal view closes
 *   (`release_terminal_size`).
 * - A client whose connection drops (the terminal WebSocket closing) keeps it
 *   only for `TERMINAL_SIZE_DISCONNECT_GRACE_MS`, enough for a reconnect.
 * - A lapsed lease means nobody owns the size, so the next resize from any
 *   client applies and makes that client the owner.
 * - The session's ownership is forgotten with the session.
 *
 * Expiry is read lazily against the clock on each decision, so the tracker
 * owns no timers. Entries exist only for sessions that were resized while
 * their PTY was running, and are capped at `MAX_TRACKED_SESSIONS` besides.
 */
import { createLogger } from "@orkestrator/protocol/logger";

const log = createLogger("terminal");

/** How long an owner keeps the size without resizing or claiming it. */
export const TERMINAL_SIZE_OWNER_LEASE_MS = 10 * 60_000;
/** How long an owner keeps the size once its connection has dropped. */
export const TERMINAL_SIZE_DISCONNECT_GRACE_MS = 30_000;
/** Hard bound on tracked sessions; the stalest owner goes first. */
export const MAX_TRACKED_TERMINAL_SIZE_OWNERS = 4_096;

export type TerminalSizeDecision = {
  /** Whether the caller's dimensions should be applied to the PTY. */
  apply: boolean;
  /** Whether the caller owns the size after this decision. */
  owned: boolean;
  /**
   * The owner sent the size it last applied, so the PTY already has it. A
   * claim repeated while typing then costs no resize at all.
   */
  unchanged: boolean;
};

export type TerminalSize = { cols: number; rows: number };

type Owner = { clientId: string; expiresAt: number; size: TerminalSize };

export type TerminalSizeOwnershipOptions = {
  now?: () => number;
  leaseMs?: number;
  disconnectGraceMs?: number;
  maxSessions?: number;
};

export class TerminalSizeOwnership {
  private readonly owners = new Map<string, Owner>();
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly disconnectGraceMs: number;
  private readonly maxSessions: number;

  constructor(options: TerminalSizeOwnershipOptions = {}) {
    this.now = options.now ?? Date.now;
    this.leaseMs = options.leaseMs ?? TERMINAL_SIZE_OWNER_LEASE_MS;
    this.disconnectGraceMs = options.disconnectGraceMs ?? TERMINAL_SIZE_DISCONNECT_GRACE_MS;
    this.maxSessions = options.maxSessions ?? MAX_TRACKED_TERMINAL_SIZE_OWNERS;
  }

  /**
   * Decides one resize of `sessionId` to `size`, and records the decision.
   * `clientId` is null for an older client that sent none: it never owns the
   * size, so its resize applies only while nobody does.
   */
  decide(
    sessionId: string,
    clientId: string | null,
    claim: boolean,
    size: TerminalSize,
  ): TerminalSizeDecision {
    const now = this.now();
    const owner = this.liveOwner(sessionId, now);
    if (clientId === null) return { apply: owner === null, owned: false, unchanged: false };
    if (claim || owner === null || owner.clientId === clientId) {
      const sameOwner = owner?.clientId === clientId;
      if (!sameOwner) {
        log.debug("size.owner-changed", () => ({
          sessionId,
          reason: claim ? "claim" : "unowned-update",
          previous: owner ? "other-client" : "none",
        }));
      }
      const unchanged = sameOwner && owner.size.cols === size.cols && owner.size.rows === size.rows;
      this.setOwner(sessionId, {
        clientId,
        expiresAt: now + this.leaseMs,
        size: { cols: size.cols, rows: size.rows },
      });
      return { apply: true, owned: true, unchanged };
    }
    return { apply: false, owned: false, unchanged: false };
  }

  /** Whether `clientId` currently owns `sessionId`'s size. */
  isOwner(sessionId: string, clientId: string): boolean {
    return this.liveOwner(sessionId, this.now())?.clientId === clientId;
  }

  /** The number of sessions with a live owner. */
  ownedSessionCount(): number {
    const now = this.now();
    let count = 0;
    for (const sessionId of Array.from(this.owners.keys())) {
      if (this.liveOwner(sessionId, now)) count += 1;
    }
    return count;
  }

  /**
   * Gives up what `clientId` owns: on `sessionId` alone, or on every session
   * when it is omitted. With `disconnected`, the ownership is kept for the
   * disconnect grace period instead, so a reconnecting client keeps its size
   * when it resizes again in time. Returns how many sessions were affected.
   */
  release(clientId: string, options: { sessionId?: string; disconnected?: boolean } = {}): number {
    const now = this.now();
    const sessionIds =
      options.sessionId === undefined ? Array.from(this.owners.keys()) : [options.sessionId];
    let released = 0;
    for (const sessionId of sessionIds) {
      const owner = this.liveOwner(sessionId, now);
      if (owner?.clientId !== clientId) continue;
      released += 1;
      if (options.disconnected) {
        owner.expiresAt = Math.min(owner.expiresAt, now + this.disconnectGraceMs);
      } else {
        this.owners.delete(sessionId);
      }
    }
    if (released > 0) {
      log.debug("size.owner-released", () => ({
        sessions: released,
        disconnected: options.disconnected === true,
      }));
    }
    return released;
  }

  /** Forgets a session's owner; called when the session itself goes away. */
  forget(sessionId: string): void {
    this.owners.delete(sessionId);
  }

  clear(): void {
    this.owners.clear();
  }

  private liveOwner(sessionId: string, now: number): Owner | null {
    const owner = this.owners.get(sessionId);
    if (!owner) return null;
    if (owner.expiresAt <= now) {
      this.owners.delete(sessionId);
      return null;
    }
    return owner;
  }

  private setOwner(sessionId: string, owner: Owner): void {
    // Re-insert so the map's order is least recently renewed first.
    this.owners.delete(sessionId);
    this.owners.set(sessionId, owner);
    while (this.owners.size > this.maxSessions) {
      const oldest = this.owners.keys().next().value;
      if (oldest === undefined) break;
      this.owners.delete(oldest);
    }
  }
}
