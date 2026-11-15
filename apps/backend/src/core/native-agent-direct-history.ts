/**
 * Direct history paging: backend cursors that wrap a provider page cursor.
 *
 * The joined sync-v1 paging path (`getMessagePage` v1 cursors) refreshes and
 * fingerprints the whole retained projection before it can serve one page.
 * When a provider serves its own pages (bridge transcript v2), a page request
 * instead validates who the cursor belongs to and asks the provider for
 * exactly that range.
 *
 * The two cursor namespaces never mix: a v1 cursor names a message id inside
 * the backend's own joined history, a v2 cursor carries the provider's opaque
 * position within one provider history epoch. Neither is translated into the
 * other; the provider rejects a stale epoch itself, and this module rejects a
 * cursor presented for a different session or logical tab.
 */
import { createHash } from "node:crypto";

/** The page input's own ceiling; a wrapped provider cursor must fit inside it. */
export const DIRECT_HISTORY_CURSOR_MAX_LENGTH = 1024;

interface DirectHistoryCursorBody {
  v: 2;
  /** Digest of the logical session storage key. */
  key: string;
  /** Digest of the provider session id. */
  session: string;
  /** Provider history epoch the position belongs to; echoed as the page's epoch. */
  epoch: string;
  /** The provider's opaque page cursor, or `ref` when it is held by handle. */
  cursor?: string;
  /** A {@link DirectHistoryCursorHandles} handle for a cursor too long to carry. */
  ref?: string;
}

function shortDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

/** Overlong provider cursors held at most, by count and by bytes (invariant 11). */
export const DIRECT_HISTORY_CURSOR_HANDLES_MAX = 1_024;
export const DIRECT_HISTORY_CURSOR_HANDLES_MAX_BYTES = 4 * 1024 * 1024;
/** A provider cursor longer than this is never held: no page route takes one. */
export const DIRECT_HISTORY_HELD_CURSOR_MAX_LENGTH = 16 * 1024;

interface HeldCursor {
  sessionKey: string;
  key: string;
  session: string;
  epoch: string;
  cursor: string;
  bytes: number;
}

/**
 * Provider cursors too long to wrap inside the page command's 1,024-character
 * cursor, held in memory and named by a short handle instead (8110).
 *
 * A handle is a digest of what it names, so the view re-registering the same
 * cursor on every read refreshes one entry rather than adding another. It is
 * served only for the session, provider session and epoch it was minted for.
 * Entries are least-recently-used and bounded by count and bytes; a handle that
 * was evicted, forgotten with its session or lost to a backend restart reads as
 * an expired cursor, which the renderer already recovers from by re-reading the
 * live view, which names a fresh handle.
 */
export class DirectHistoryCursorHandles {
  private readonly entries = new Map<string, HeldCursor>();
  private totalBytes = 0;

  constructor(
    private readonly limits: { maxEntries: number; maxBytes: number } = {
      maxEntries: DIRECT_HISTORY_CURSOR_HANDLES_MAX,
      maxBytes: DIRECT_HISTORY_CURSOR_HANDLES_MAX_BYTES,
    },
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  /** Hold `cursor` and return its handle, or undefined for one too long to hold. */
  register(input: {
    sessionKey: string;
    key: string;
    session: string;
    epoch: string;
    cursor: string;
  }): string | undefined {
    if (input.cursor.length > DIRECT_HISTORY_HELD_CURSOR_MAX_LENGTH) return undefined;
    const handle = createHash("sha256")
      .update(JSON.stringify([input.key, input.session, input.epoch, input.cursor]))
      .digest("base64url")
      .slice(0, 32);
    const existing = this.entries.get(handle);
    if (existing) {
      this.entries.delete(handle);
      this.entries.set(handle, existing);
      return handle;
    }
    const bytes = 256 + input.sessionKey.length + input.epoch.length + input.cursor.length;
    if (bytes > this.limits.maxBytes) return undefined;
    this.entries.set(handle, { ...input, bytes });
    this.totalBytes += bytes;
    while (this.entries.size > this.limits.maxEntries || this.totalBytes > this.limits.maxBytes) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
    return handle;
  }

  /** The cursor a handle names, only for the owner and epoch it was minted for. */
  resolve(handle: string, owner: { key: string; session: string; epoch: string }) {
    const entry = this.entries.get(handle);
    if (
      !entry ||
      entry.key !== owner.key ||
      entry.session !== owner.session ||
      entry.epoch !== owner.epoch
    ) {
      return undefined;
    }
    this.entries.delete(handle);
    this.entries.set(handle, entry);
    return entry.cursor;
  }

  /** Drop every cursor held for a logical session (rewind, resume, replacement). */
  forgetSession(sessionKey: string): void {
    for (const [handle, entry] of Array.from(this.entries)) {
      if (entry.sessionKey === sessionKey) this.remove(handle);
    }
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  private remove(handle: string): void {
    const entry = this.entries.get(handle);
    if (!entry) return;
    this.entries.delete(handle);
    this.totalBytes -= entry.bytes;
  }
}

export function encodeDirectHistoryCursor(
  input: {
    sessionKey: string;
    providerSessionId: string;
    historyEpoch: string;
    providerCursor: string;
  },
  handles?: DirectHistoryCursorHandles,
): string | undefined {
  const body: DirectHistoryCursorBody = {
    v: 2,
    key: shortDigest(input.sessionKey),
    session: shortDigest(input.providerSessionId),
    epoch: input.historyEpoch,
    cursor: input.providerCursor,
  };
  const encoded = Buffer.from(JSON.stringify(body)).toString("base64url");
  if (encoded.length <= DIRECT_HISTORY_CURSOR_MAX_LENGTH) return encoded;
  // Too long to round-trip through the page command, whose validator would
  // reject it: carry a handle for it instead, where the caller holds them.
  const ref = handles?.register({
    sessionKey: input.sessionKey,
    key: body.key,
    session: body.session,
    epoch: body.epoch,
    cursor: input.providerCursor,
  });
  if (!ref) return undefined;
  const heldBody: DirectHistoryCursorBody = {
    v: 2,
    key: body.key,
    session: body.session,
    epoch: body.epoch,
    ref,
  };
  const held = Buffer.from(JSON.stringify(heldBody)).toString("base64url");
  return held.length <= DIRECT_HISTORY_CURSOR_MAX_LENGTH ? held : undefined;
}

export type DecodedHistoryCursor =
  { version: 1 } | { version: 2; epoch: string; providerCursor: string } | { version: "invalid" };

/**
 * Classify a page cursor and, for a direct one, check it belongs to this
 * logical session and provider session. A cursor minted for another session
 * is reported `invalid`, never served against the wrong history, and so is a
 * handle the caller no longer holds (or holds none for).
 */
export function decodeHistoryCursor(
  cursor: string,
  owner: { sessionKey: string; providerSessionId: string },
  handles?: DirectHistoryCursorHandles,
): DecodedHistoryCursor {
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return { version: "invalid" };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { version: "invalid" };
  const record = body as Record<string, unknown>;
  if (record.v === 1) return { version: 1 };
  const key = shortDigest(owner.sessionKey);
  const session = shortDigest(owner.providerSessionId);
  if (
    record.v !== 2 ||
    record.key !== key ||
    record.session !== session ||
    typeof record.epoch !== "string" ||
    record.epoch.length === 0 ||
    record.epoch.length > 128
  ) {
    return { version: "invalid" };
  }
  const providerCursor =
    typeof record.cursor === "string"
      ? record.cursor
      : typeof record.ref === "string" && handles
        ? handles.resolve(record.ref, { key, session, epoch: record.epoch })
        : undefined;
  if (!providerCursor) return { version: "invalid" };
  return { version: 2, epoch: record.epoch, providerCursor };
}

export interface DirectHistoryPageCacheLimits {
  maxEntries: number;
  maxBytes: number;
  maxSessionEntries: number;
  maxSessionBytes: number;
  /**
   * Backstop for a provider that edits history without rotating its epoch.
   * Within one epoch a page is immutable by contract.
   */
  ttlMs: number;
}

/** Sessions whose current epoch is remembered; older observations are dropped. */
const MAX_OBSERVED_SESSIONS = 1_024;

interface ObservedHistory {
  providerSessionId: string;
  epoch: string;
  pages: Set<string>;
  bytes: number;
}

interface CachedPage<V> {
  sessionKey: string;
  value: V;
  bytes: number;
  expiresAt: number;
}

interface PageRead {
  sessionKey: string;
  providerSessionId: string;
  epoch: string;
  /** Set when the session's history changed or was forgotten mid-read. */
  stale: boolean;
  promise?: Promise<unknown>;
}

/**
 * Immutable direct history pages, served again without a provider read while
 * the backend still believes their epoch is current.
 *
 * "Current" is the epoch the provider most recently reported for the session,
 * from the live transcript read or from a page it served. A page is served
 * only for that exact provider session and epoch; observing any other epoch
 * drops the session's pages, as does forgetting the session (rewind, resume,
 * replacement). A read already in flight when that happens still answers its
 * callers but is not admitted, so it cannot repopulate the cache with a
 * history the session has left.
 *
 * Concurrent requests for the same page share one provider read. No caller
 * owns it: nothing a single caller does can cancel it for the others, and its
 * rejection is observed here so a caller that went away leaves no unhandled
 * rejection behind.
 */
export class DirectHistoryPageCache<V> {
  private readonly pages = new Map<string, CachedPage<V>>();
  private readonly observed = new Map<string, ObservedHistory>();
  private readonly reads = new Map<string, PageRead>();
  private totalBytes = 0;

  constructor(private readonly limits: DirectHistoryPageCacheLimits) {}

  get size(): number {
    return this.pages.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  /** Sessions whose provider epoch is recorded, for cache gauges. */
  get observedSessions(): number {
    return this.observed.size;
  }

  /** Page reads in flight, for cache gauges. */
  get pendingReads(): number {
    return this.reads.size;
  }

  /** Record the provider's current epoch for a session; any change drops its pages. */
  observeEpoch(sessionKey: string, providerSessionId: string, epoch: string): void {
    const current = this.observed.get(sessionKey);
    if (current?.providerSessionId === providerSessionId && current.epoch === epoch) {
      this.observed.delete(sessionKey);
      this.observed.set(sessionKey, current);
      return;
    }
    // A different history: its pages go, and reads still in flight against it
    // must neither be admitted nor restore their epoch as the current one.
    // With no remembered epoch (a restart, eviction or forgotten session) the
    // reads for any other history are stopped the same way.
    if (current) this.forgetSession(sessionKey);
    else
      this.staleReads(
        sessionKey,
        (flight) => flight.providerSessionId !== providerSessionId || flight.epoch !== epoch,
      );
    this.observed.set(sessionKey, { providerSessionId, epoch, pages: new Set(), bytes: 0 });
    while (this.observed.size > MAX_OBSERVED_SESSIONS) {
      const oldest = this.observed.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.forgetSession(oldest);
    }
  }

  /** A cached page for this exact session, provider session and epoch. */
  lookup(
    sessionKey: string,
    providerSessionId: string,
    epoch: string,
    key: string,
    now: number,
  ): V | undefined {
    const history = this.observed.get(sessionKey);
    if (history?.providerSessionId !== providerSessionId || history.epoch !== epoch) {
      return undefined;
    }
    const page = this.pages.get(key);
    if (!page || page.sessionKey !== sessionKey) return undefined;
    if (page.expiresAt <= now) {
      this.delete(key);
      return undefined;
    }
    this.pages.delete(key);
    this.pages.set(key, page);
    history.pages.delete(key);
    history.pages.add(key);
    return page.value;
  }

  /**
   * The unexpired pages of a session's current history, without refreshing
   * their recency. Bounded by the per-session limits.
   */
  *sessionValues(sessionKey: string, now: number): Generator<V> {
    const history = this.observed.get(sessionKey);
    if (!history) return;
    for (const key of Array.from(history.pages)) {
      const page = this.pages.get(key);
      if (page && page.sessionKey === sessionKey && page.expiresAt > now) yield page.value;
    }
  }

  /**
   * Read a page once for every concurrent caller of the same key, and admit
   * it when the session's history held still for the whole read.
   */
  load(
    input: { sessionKey: string; providerSessionId: string; epoch: string; key: string },
    read: () => Promise<{ value: V; bytes: number }>,
    now: () => number,
  ): Promise<V> {
    const existing = this.reads.get(input.key);
    if (existing?.promise) return existing.promise as Promise<V>;
    const flight: PageRead = {
      sessionKey: input.sessionKey,
      providerSessionId: input.providerSessionId,
      epoch: input.epoch,
      stale: false,
    };
    this.reads.set(input.key, flight);
    const promise = (async () => {
      const { value, bytes } = await read();
      if (!flight.stale) {
        // The provider has just confirmed this epoch for the session.
        this.observeEpoch(input.sessionKey, input.providerSessionId, input.epoch);
        this.store(input.sessionKey, input.key, value, bytes, now());
      }
      return value;
    })().finally(() => {
      if (this.reads.get(input.key) === flight) this.reads.delete(input.key);
    });
    // Every caller awaits `promise`; this only keeps a rejection nobody is
    // still waiting for from surfacing as unhandled.
    promise.catch(() => undefined);
    flight.promise = promise;
    return promise;
  }

  private store(sessionKey: string, key: string, value: V, bytes: number, now: number): void {
    const history = this.observed.get(sessionKey);
    if (
      !history ||
      this.limits.ttlMs <= 0 ||
      bytes > this.limits.maxBytes ||
      bytes > this.limits.maxSessionBytes
    ) {
      return;
    }
    this.delete(key);
    this.pages.set(key, { sessionKey, value, bytes, expiresAt: now + this.limits.ttlMs });
    history.pages.add(key);
    history.bytes += bytes;
    this.totalBytes += bytes;
    while (
      history.pages.size > this.limits.maxSessionEntries ||
      history.bytes > this.limits.maxSessionBytes
    ) {
      const oldest = history.pages.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
    while (this.pages.size > this.limits.maxEntries || this.totalBytes > this.limits.maxBytes) {
      const oldest = this.pages.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }

  /** Drop one page, e.g. when its detail references can no longer be restored. */
  delete(key: string): void {
    const page = this.pages.get(key);
    if (!page) return;
    this.pages.delete(key);
    this.totalBytes -= page.bytes;
    const history = this.observed.get(page.sessionKey);
    if (history?.pages.delete(key)) history.bytes -= page.bytes;
  }

  /** Drop a session's pages and epoch, and keep in-flight reads from admitting. */
  forgetSession(sessionKey: string): void {
    const history = this.observed.get(sessionKey);
    if (history) {
      for (const key of Array.from(history.pages)) this.delete(key);
      this.observed.delete(sessionKey);
    }
    this.staleReads(sessionKey, () => true);
  }

  private staleReads(sessionKey: string, matches: (flight: PageRead) => boolean): void {
    for (const [key, flight] of this.reads) {
      if (flight.sessionKey !== sessionKey || !matches(flight)) continue;
      // Later callers start a fresh read rather than joining this one.
      flight.stale = true;
      this.reads.delete(key);
    }
  }

  clear(): void {
    for (const flight of this.reads.values()) flight.stale = true;
    this.reads.clear();
    this.pages.clear();
    this.observed.clear();
    this.totalBytes = 0;
  }
}
