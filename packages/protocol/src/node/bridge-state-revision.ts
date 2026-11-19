import { createHash, randomBytes } from "node:crypto";
import {
  isBridgeStateRevision,
  type BridgeStateUnchangedAnswer,
} from "../bridge-state-revision.js";

export {
  BRIDGE_KNOWN_COMPOSER_REVISION_PARAM,
  BRIDGE_KNOWN_STATE_REVISION_PARAM,
  BRIDGE_STATE_REVISION_VERSION,
  type BridgeStateUnchangedAnswer,
} from "../bridge-state-revision.js";

/** Sessions one tracker remembers; the oldest is forgotten past this. */
export const BRIDGE_STATE_REVISION_MAX_SESSIONS = 4_096;

interface Entry {
  counter: number;
  /** Digest of the content the state read last returned, and at which counter. */
  digest?: string;
  digestCounter?: number;
}

export interface BridgeStateRevisionsOptions {
  /** The bridge process generation; a fresh random id by default. */
  generation?: string;
  maxSessions?: number;
}

/**
 * Per-session state revisions of one bridge process (`<generation>:<counter>`,
 * see `@orkestrator/protocol/bridge-state-revision`).
 *
 * Two inputs move a revision, and either is enough:
 *
 * - **`bump`** at a mutation site or from the bridge's event fan-out. O(1),
 *   synchronous and safe inside an SDK listener. This is what the observe
 *   stream's frames carry (`peek`), so it is how the backend learns of a
 *   change without reading.
 * - **`settle`** on every state read, with exactly what the read returns. A
 *   content digest that differs from the one recorded at the current counter
 *   moves it. So the `unchanged` answer is always true, even for a mutation
 *   site that forgot to bump; a forgotten bump only costs push latency, and
 *   each bridge's revision harness test fails on it.
 *
 * The counter is process-wide: two sessions never share a revision and a
 * forgotten (evicted) session gets a fresh one, so a stale `knownStateRevision`
 * can never match by accident.
 */
export class BridgeStateRevisions {
  readonly generation: string;
  private counter = 0;
  private readonly entries = new Map<string, Entry>();
  private readonly maxSessions: number;

  constructor(options: BridgeStateRevisionsOptions = {}) {
    const generation = options.generation ?? randomBytes(9).toString("base64url");
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(generation)) {
      throw new Error("Bridge state revision generation must be 1-64 URL-safe characters");
    }
    this.generation = generation;
    this.maxSessions = Math.max(1, options.maxSessions ?? BRIDGE_STATE_REVISION_MAX_SESSIONS);
  }

  /** Move a session's revision; returns the new one. Never throws. */
  bump(sessionId: string): string {
    const entry = this.entry(sessionId);
    entry.counter = ++this.counter;
    return this.format(entry);
  }

  /** The current revision, without reading anything (observe frames, tests). */
  peek(sessionId: string): string {
    return this.format(this.entry(sessionId));
  }

  /**
   * The state read: reconciles the revision against what the read returns.
   * `content` is everything the backend's state read gets for this session,
   * minus fields that are liveness rather than state (a `lastActivity` the
   * read itself moves). JSON-serialisable.
   */
  settle(sessionId: string, content: unknown): string {
    const digest = contentDigest(content);
    const entry = this.entry(sessionId);
    if (
      entry.digest !== undefined &&
      entry.digestCounter === entry.counter &&
      entry.digest !== digest
    ) {
      entry.counter = ++this.counter;
    }
    entry.digest = digest;
    entry.digestCounter = entry.counter;
    return this.format(entry);
  }

  /**
   * `settle`, then the answer for a request that named `known`: `unchanged`
   * when it is still current, otherwise the revision to put on the full body.
   */
  answer(
    sessionId: string,
    content: unknown,
    known: string | null | undefined,
  ):
    { unchanged: true; body: BridgeStateUnchangedAnswer } | { unchanged: false; revision: string } {
    const revision = this.settle(sessionId, content);
    if (known && isBridgeStateRevision(known) && known === revision) {
      return { unchanged: true, body: { unchanged: true, stateRevision: revision } };
    }
    return { unchanged: false, revision };
  }

  /** Drop a session (closed, evicted). Its next revision is new. */
  forget(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  get size(): number {
    return this.entries.size;
  }

  private entry(sessionId: string): Entry {
    let entry = this.entries.get(sessionId);
    if (entry) return entry;
    entry = { counter: ++this.counter };
    this.entries.set(sessionId, entry);
    while (this.entries.size > this.maxSessions) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined || oldest === sessionId) break;
      this.entries.delete(oldest);
    }
    return entry;
  }

  private format(entry: Entry): string {
    return `${this.generation}:${entry.counter}`;
  }
}

/** A short digest of a JSON-serialisable value. Change detection, not security. */
export function contentDigest(content: unknown): string {
  return createHash("sha1")
    .update(JSON.stringify(content) ?? "undefined")
    .digest("base64url");
}

/**
 * A revision harness for bridge tests: snapshot what a state read returns and
 * the revision peeked without reading, run a mutation, and report when the
 * body changed but the peeked revision did not (D7, "the test that keeps it
 * honest"). `read` must return exactly what the backend's state read gets
 * (the body plus its side routes), minus liveness-only fields.
 */
export async function expectStateRevisionMoves(input: {
  label: string;
  read: () => unknown | Promise<unknown>;
  peek: () => string;
  mutate: () => unknown | Promise<unknown>;
}): Promise<{ changed: boolean; moved: boolean }> {
  const before = contentDigest(await input.read());
  const revisionBefore = input.peek();
  await input.mutate();
  const revisionAfter = input.peek();
  const after = contentDigest(await input.read());
  const changed = before !== after;
  const moved = revisionBefore !== revisionAfter;
  if (changed && !moved) {
    throw new Error(
      `${input.label}: the state read changed but its revision did not move (${revisionBefore})`,
    );
  }
  return { changed, moved };
}
