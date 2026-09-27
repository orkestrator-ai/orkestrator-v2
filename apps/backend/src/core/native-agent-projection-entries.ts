/**
 * Projected transcript rows reused across changed reads.
 *
 * A changed read used to rebuild every row of the window: spread each part,
 * move its heavy bodies behind detail references (serializing and hashing
 * each body to mint the reference), fold progress rows, and then serialize
 * the new object to discover it had not changed. A streaming tail therefore
 * re-normalized the whole immutable prefix on every poll.
 *
 * No provider exposes a per-message revision, and every bridge read parses
 * fresh objects, so object identity says nothing about content. An entry is
 * instead reused only when the incoming provider row is structurally equal —
 * same keys in the same order, same values — to a private copy taken when the
 * entry was built. That check reads the row once without allocating, hashing
 * or serializing, and it is exact: a provider that mutates a row in place (or
 * reuses an object for new content) differs from the copy and misses.
 *
 * The projection then runs from the copy rather than from the provider row,
 * so the cached projected value shares structure only with memory nothing
 * else can mutate. Strings are shared, not copied: they are immutable.
 *
 * Entries are scoped to one logical session and presentation context (the
 * session key, whether details resolve remotely and through which provider
 * session, and coordinator display), and each records the per-row context the
 * projection reads beyond the row itself (prompt presentation). Two contexts
 * never share an entry. Cache membership is a performance property only: an
 * entry can only ever answer for content identical to what built it.
 */

/** A detail reference a projected row registered, replayable without its body. */
export interface ProjectionDetailRegistration {
  ref: string;
  /** Present for a provider-held detail: enough to register it again. */
  remote?: { messageId: string; partPath: string; providerSessionId: string; locator: string };
}

export interface ProjectionEntryContext {
  sessionKey: string;
  /** Provider session whose locators resolve details; absent for inline bodies. */
  remoteSessionId?: string;
  coordinator: boolean;
}

export interface ProjectedMessageEntry {
  projected: unknown;
  details: readonly ProjectionDetailRegistration[];
}

interface StoredEntry extends ProjectedMessageEntry {
  key: string;
  sessionKey: string;
  source: unknown;
  promptPresentation: string | undefined;
  /** Estimated retained bytes of the private source copy. */
  sourceBytes: number;
  /** Encoded bytes of the projected value (its memoized JSON is retained too). */
  encodedBytes: number;
}

export interface ProjectedMessageCacheLimits {
  maxEntries: number;
  maxBytes: number;
  maxSessionEntries: number;
  maxSessionBytes: number;
  /** Larger rows are projected every read rather than admitted. */
  maxEntryBytes: number;
}

/** Deeper structures are projected every read rather than copied. */
const MAX_SOURCE_DEPTH = 64;
/** Rough per-node overhead of a retained object, array or primitive slot. */
const NODE_BYTES = 32;

/** The key order of each private copy, so comparison allocates nothing. */
const copiedKeyOrders = new WeakMap<object, readonly string[]>();

class UncacheableSource extends Error {}

function plainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/**
 * A private structural copy of a JSON-shaped provider row and its estimated
 * retained size, or undefined when the row holds anything a copy could not
 * reproduce exactly (class instances, functions, excessive depth).
 */
export function copyProjectionSource(value: unknown): { copy: unknown; bytes: number } | undefined {
  let bytes = 0;
  const visit = (node: unknown, depth: number): unknown => {
    if (node === null || typeof node !== "object") {
      if (typeof node === "function" || typeof node === "symbol" || typeof node === "bigint") {
        throw new UncacheableSource();
      }
      bytes += typeof node === "string" ? NODE_BYTES + node.length : NODE_BYTES;
      return node;
    }
    if (depth >= MAX_SOURCE_DEPTH) throw new UncacheableSource();
    bytes += NODE_BYTES;
    if (Array.isArray(node)) {
      const copy: unknown[] = [];
      for (let index = 0; index < node.length; index += 1) {
        // Array callbacks skip a hole but not an `undefined`; parsed JSON has
        // no holes, so the rare row that does keeps the uncached path.
        if (!(index in node)) throw new UncacheableSource();
        copy.push(visit(node[index], depth + 1));
      }
      return copy;
    }
    if (!plainObject(node)) throw new UncacheableSource();
    const record = node as Record<string, unknown>;
    const copy: Record<string, unknown> = {};
    const keys: string[] = [];
    for (const key in record) {
      keys.push(key);
      bytes += key.length;
      const child = visit(record[key], depth + 1);
      // A parsed `__proto__` key is an own property; assignment would instead
      // replace the copy's prototype.
      if (key === "__proto__") {
        Object.defineProperty(copy, key, {
          value: child,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      } else {
        copy[key] = child;
      }
    }
    copiedKeyOrders.set(copy, keys);
    return copy;
  };
  try {
    const copy = visit(value, 0);
    return { copy, bytes };
  } catch (error) {
    if (error instanceof UncacheableSource || error instanceof RangeError) return undefined;
    throw error;
  }
}

/**
 * Whether a provider row equals a private copy: same keys in the same order
 * (key order reaches the encoded projection) and equal values throughout.
 */
export function sameProjectionSource(value: unknown, copy: unknown, depth = 0): boolean {
  if (value === copy) return true;
  if (value === null || copy === null || typeof value !== "object" || typeof copy !== "object") {
    return false;
  }
  if (depth >= MAX_SOURCE_DEPTH) return false;
  if (Array.isArray(value)) {
    if (!Array.isArray(copy) || value.length !== copy.length) return false;
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value) || !sameProjectionSource(value[index], copy[index], depth + 1)) {
        return false;
      }
    }
    return true;
  }
  if (Array.isArray(copy) || !plainObject(value)) return false;
  const keys = copiedKeyOrders.get(copy);
  if (!keys) return false;
  const record = value as Record<string, unknown>;
  const copied = copy as Record<string, unknown>;
  let index = 0;
  for (const key in record) {
    if (keys[index] !== key || !sameProjectionSource(record[key], copied[key], depth + 1)) {
      return false;
    }
    index += 1;
  }
  return index === keys.length;
}

/**
 * Bounded, least-recently-used projected rows. Global and per-session entry
 * and byte ceilings both apply; a row too large for its share is simply not
 * admitted and keeps the uncached path.
 */
export class ProjectedMessageCache {
  private readonly entries = new Map<string, StoredEntry>();
  private readonly sessions = new Map<
    string,
    { entries: Map<string, StoredEntry>; bytes: number }
  >();
  private totalBytes = 0;

  constructor(private readonly limits: ProjectedMessageCacheLimits) {}

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  /** Whether anything could be admitted; a disabled cache skips the source copy. */
  get enabled(): boolean {
    return this.limits.maxEntries > 0 && this.limits.maxSessionEntries > 0;
  }

  private static key(context: ProjectionEntryContext, messageId: string): string {
    return `${context.sessionKey}\0${context.remoteSessionId ?? ""}\0${
      context.coordinator ? "coordinator" : ""
    }\0${messageId}`;
  }

  /**
   * The entry projected from a row equal to `source` in this context, with its
   * recency refreshed; undefined when absent or the row changed.
   */
  lookup(
    context: ProjectionEntryContext,
    messageId: string,
    source: unknown,
    promptPresentation: string | undefined,
  ): ProjectedMessageEntry | undefined {
    const key = ProjectedMessageCache.key(context, messageId);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (
      entry.promptPresentation !== promptPresentation ||
      !sameProjectionSource(source, entry.source)
    ) {
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    const session = this.sessions.get(entry.sessionKey);
    if (session) {
      session.entries.delete(key);
      session.entries.set(key, entry);
    }
    return entry;
  }

  store(
    context: ProjectionEntryContext,
    messageId: string,
    source: { copy: unknown; bytes: number },
    promptPresentation: string | undefined,
    value: ProjectedMessageEntry & { encodedBytes: number },
  ): void {
    const key = ProjectedMessageCache.key(context, messageId);
    this.delete(key);
    const detailBytes = value.details.reduce(
      (total, detail) =>
        total +
        NODE_BYTES +
        detail.ref.length +
        (detail.remote
          ? detail.remote.messageId.length +
            detail.remote.partPath.length +
            detail.remote.providerSessionId.length +
            detail.remote.locator.length
          : 0),
      0,
    );
    const entry: StoredEntry = {
      key,
      sessionKey: context.sessionKey,
      source: source.copy,
      promptPresentation,
      projected: value.projected,
      details: value.details,
      sourceBytes: source.bytes + detailBytes + key.length + NODE_BYTES,
      encodedBytes: value.encodedBytes,
    };
    const bytes = entry.sourceBytes + entry.encodedBytes;
    if (
      !this.enabled ||
      bytes > this.limits.maxEntryBytes ||
      bytes > this.limits.maxSessionBytes ||
      bytes > this.limits.maxBytes
    ) {
      return;
    }
    let session = this.sessions.get(context.sessionKey);
    if (!session) {
      session = { entries: new Map(), bytes: 0 };
      this.sessions.set(context.sessionKey, session);
    }
    this.entries.set(key, entry);
    session.entries.set(key, entry);
    session.bytes += bytes;
    this.totalBytes += bytes;
    while (
      session.entries.size > this.limits.maxSessionEntries ||
      session.bytes > this.limits.maxSessionBytes
    ) {
      const oldest = session.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
    while (this.entries.size > this.limits.maxEntries || this.totalBytes > this.limits.maxBytes) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }

  private delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    const bytes = entry.sourceBytes + entry.encodedBytes;
    this.entries.delete(key);
    this.totalBytes -= bytes;
    const session = this.sessions.get(entry.sessionKey);
    if (!session) return;
    session.entries.delete(key);
    session.bytes -= bytes;
    if (session.entries.size === 0) this.sessions.delete(entry.sessionKey);
  }

  /** Drop every entry of a logical session, in all of its contexts. */
  forgetSession(sessionKey: string): void {
    const session = this.sessions.get(sessionKey);
    if (!session) return;
    for (const key of Array.from(session.entries.keys())) this.delete(key);
    this.sessions.delete(sessionKey);
  }

  clear(): void {
    this.entries.clear();
    this.sessions.clear();
    this.totalBytes = 0;
  }
}
