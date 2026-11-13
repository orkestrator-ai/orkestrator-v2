/**
 * Recent transcript views a lagging or second reader may still hold (TX-1).
 *
 * A delta needs the view the reader has. The progressive cache keeps only the
 * newest view per key, so anyone one revision behind used to get a whole
 * snapshot, and two readers of one session kept each other there. This ring
 * keeps the views the newest one superseded, per key, bounded by count and
 * bytes the way `state.revisions` bounds sync revisions; a token older than the
 * ring still gets a snapshot.
 *
 * Consecutive views share row objects (`reuseUnchangedMessages`), so a base is
 * charged only for the rows its successor no longer holds. Bases leave oldest
 * first, so a row is always charged to exactly the entry that keeps it alive.
 *
 * The ring is contiguous by construction: anything that would leave a hole (a
 * different history, a base too large to keep) empties it, because a delta
 * across a hole could miss what happened inside it.
 *
 * A part-trimmed head row that the backend recovers once a second grows on
 * every recovery, so consecutive views never share it and a base holding it
 * costs the whole row. Past about a million characters that is more than the
 * per-key bound, which used to empty the ring on every recovery and send
 * every reader a whole snapshot (todo 7845 task 1). The per-key bound now
 * sheds older bases but always keeps the newest one: a base over the key
 * bound replaces the ring rather than emptying it, so a reader one view
 * behind still gets a delta, and with patches the grown row travels as its
 * appended parts. Only a base over `maxBaseBytes` is too large to keep.
 */
import {
  NATIVE_AGENT_REVISED_MESSAGES_MAX,
  type NativeAgentTranscriptDelta,
  type NativeAgentTranscriptView,
} from "@orkestrator/protocol/native-agent";
import {
  encodedBytesWithMessages,
  encodedValue,
  sameEncoding,
  tailDeletions,
} from "./native-agent-projection-encoding.js";
import { NATIVE_REVISED_MESSAGES_MAX_BYTES } from "./native-agent-service-shared.js";

export const NATIVE_TRANSCRIPT_DELTA_MAX_BASES = 8;
export const NATIVE_TRANSCRIPT_DELTA_MAX_KEY_BYTES = 2 * 1024 * 1024;
/**
 * The most one base may cost when it is the only one its key keeps. Covers a
 * recovered head row of about four million characters; a larger base empties
 * the ring and its readers get a snapshot.
 */
export const NATIVE_TRANSCRIPT_DELTA_MAX_BASE_BYTES = 8 * 1024 * 1024;
export const NATIVE_TRANSCRIPT_DELTA_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
/** One array slot per row a base keeps, whether or not it is charged for the row. */
const ROW_REFERENCE_BYTES = 8;

export interface TranscriptDeltaBaseLimits {
  maxBases: number;
  maxKeyBytes: number;
  /** Bound on a single base, which the ring keeps alone when it exceeds `maxKeyBytes`. */
  maxBaseBytes: number;
  maxTotalBytes: number;
}

interface TranscriptDeltaBase {
  token: string;
  value: NativeAgentTranscriptView;
  bytes: number;
}

interface TranscriptDeltaRing {
  bases: TranscriptDeltaBase[];
  bytes: number;
}

/** A base a reader holds, and the views between it and the newest one. */
export interface TranscriptDeltaChain {
  base: NativeAgentTranscriptView;
  later: readonly NativeAgentTranscriptView[];
}

function sameHistory(left: NativeAgentTranscriptView, right: NativeAgentTranscriptView): boolean {
  return (
    left.historyEpoch === right.historyEpoch &&
    left.identity.providerSessionId === right.identity.providerSessionId &&
    left.identity.sourceGeneration === right.identity.sourceGeneration
  );
}

/** What keeping `value` costs beyond what its successor already holds. */
function retainedBytes(value: NativeAgentTranscriptView, successor: NativeAgentTranscriptView) {
  const shared = new Set(successor.messages);
  return (
    encodedBytesWithMessages({
      ...value,
      messages: value.messages.filter((message) => !shared.has(message)),
    }) +
    value.messages.length * ROW_REFERENCE_BYTES
  );
}

export class TranscriptDeltaBases {
  private readonly rings = new Map<string, TranscriptDeltaRing>();
  private bytes = 0;

  constructor(
    private readonly limits: TranscriptDeltaBaseLimits = {
      maxBases: NATIVE_TRANSCRIPT_DELTA_MAX_BASES,
      maxKeyBytes: NATIVE_TRANSCRIPT_DELTA_MAX_KEY_BYTES,
      maxBaseBytes: NATIVE_TRANSCRIPT_DELTA_MAX_BASE_BYTES,
      maxTotalBytes: NATIVE_TRANSCRIPT_DELTA_MAX_TOTAL_BYTES,
    },
  ) {}

  /** `superseded` was the key's newest view until `next` replaced it. */
  record(
    key: string,
    superseded: { token: string; value: NativeAgentTranscriptView },
    next: NativeAgentTranscriptView,
  ): void {
    if (!sameHistory(superseded.value, next)) {
      this.forget(key);
      return;
    }
    const bytes = retainedBytes(superseded.value, next);
    if (bytes > Math.max(this.limits.maxKeyBytes, this.limits.maxBaseBytes)) {
      this.forget(key);
      return;
    }
    const ring = this.rings.get(key) ?? { bases: [], bytes: 0 };
    // Most recently written last, so the total bound sheds the quietest key.
    this.rings.delete(key);
    this.rings.set(key, ring);
    ring.bases.push({ token: superseded.token, value: superseded.value, bytes });
    ring.bytes += bytes;
    this.bytes += bytes;
    // Oldest first, but never the base just added: shedding it would leave the
    // ring empty for a reader one view behind, the case the ring exists for.
    while (
      ring.bases.length > this.limits.maxBases ||
      (ring.bytes > this.limits.maxKeyBytes && ring.bases.length > 1)
    ) {
      this.shedOldest(key, ring);
    }
    while (this.bytes > this.limits.maxTotalBytes) {
      const oldest = this.rings.entries().next().value;
      if (!oldest) break;
      this.shedOldest(oldest[0], oldest[1]);
    }
  }

  /** The newest base with this token, if the ring still holds one. */
  chain(key: string, token: string): TranscriptDeltaChain | undefined {
    const bases = this.rings.get(key)?.bases;
    if (!bases) return undefined;
    const index = bases.findLastIndex((base) => base.token === token);
    if (index < 0) return undefined;
    return {
      base: bases[index]!.value,
      later: bases.slice(index + 1).map((base) => base.value),
    };
  }

  forget(key: string): void {
    const ring = this.rings.get(key);
    if (!ring) return;
    this.bytes -= ring.bytes;
    this.rings.delete(key);
  }

  clear(): void {
    this.rings.clear();
    this.bytes = 0;
  }

  /** Keys holding a ring, for cache gauges. */
  get size(): number {
    return this.rings.size;
  }

  /** What the rings charge in total, for cache gauges. */
  get retainedBytes(): number {
    return this.bytes;
  }

  /** Test-only: what the ring holds and charges, for the bounds it promises. */
  forTesting() {
    return {
      totalBytes: () => this.bytes,
      keys: () => [...this.rings.keys()],
      baseCount: (key: string) => this.rings.get(key)?.bases.length ?? 0,
      keyBytes: (key: string) => this.rings.get(key)?.bytes ?? 0,
      chargedBytes: () =>
        [...this.rings.values()].reduce(
          (total, ring) => total + ring.bases.reduce((sum, base) => sum + base.bytes, 0),
          0,
        ),
    };
  }

  private shedOldest(key: string, ring: TranscriptDeltaRing): void {
    const removed = ring.bases.shift();
    if (removed) {
      ring.bytes -= removed.bytes;
      this.bytes -= removed.bytes;
    }
    if (ring.bases.length === 0) this.rings.delete(key);
  }
}

const idOf = (message: unknown) => (message as { id: string }).id;

/**
 * Add to a delta computed directly from a base what only the views in between
 * can say: a reader who saw each one would have been told these things, and the
 * comparison of two endpoints cannot recover them.
 *
 * - A row removed in between, then pushed out of range, looks merely aged out.
 * - A row the reader holds that changed before leaving the window, or a revised
 *   row no longer listed, would stay stale on the reader's screen. Each goes in
 *   `revisedMessages`, which readers apply to the copies they hold.
 *
 * `null` means send a snapshot: the windows share nothing, so a delta would
 * leave a gap in what the reader holds, or the rows to carry exceed the bound
 * every revised list keeps to.
 */
export function chainedTranscriptDelta(
  direct: NativeAgentTranscriptDelta,
  chain: TranscriptDeltaChain,
  current: NativeAgentTranscriptView,
): NativeAgentTranscriptDelta | null {
  if (chain.later.length === 0) return direct;
  const window = new Set(current.messages.map(idOf));
  const { base, later } = chain;
  if (base.messages.length > 0 && !base.messages.some((message) => window.has(idOf(message)))) {
    return null;
  }

  const deleted = new Set(direct.deletedMessageIds);
  const views = [base, ...later, current];
  for (let index = 1; index < views.length; index += 1) {
    const next = views[index]!;
    const removed = tailDeletions(
      views[index - 1]!.messages.map(idOf),
      next.messages.map(idOf),
      !next.historyComplete || next.historyCursor !== undefined,
    );
    for (const id of removed) deleted.add(id);
    // Restoration cancels an earlier deletion even if the row later ages out.
    for (const message of next.messages) deleted.delete(idOf(message));
  }

  const heldRows = new Map(base.messages.map((message) => [idOf(message), message] as const));
  const heldRevised = new Map(
    (base.revisedMessages ?? []).map((message) => [idOf(message), message] as const),
  );
  const decided = new Set((current.revisedMessages ?? []).map(idOf));
  const carried: unknown[] = [];
  let carriedBytes = (direct.revisedMessages ?? []).reduce<number>(
    (total, row) => total + encodedValue(row).bytes,
    0,
  );
  const carry = (row: unknown): boolean => {
    const id = idOf(row);
    if (window.has(id) || decided.has(id)) return true;
    decided.add(id);
    const held = heldRevised.get(id) ?? heldRows.get(id);
    if (held !== undefined && sameEncoding(held, row)) return true;
    carriedBytes += encodedValue(row).bytes;
    carried.push(row);
    return carriedBytes <= NATIVE_REVISED_MESSAGES_MAX_BYTES;
  };
  // Newest first, so the newest copy of a row is the one that travels.
  for (const view of [...later].reverse()) {
    for (const row of view.revisedMessages ?? []) if (!carry(row)) return null;
    // A part-trimmed head row would cost the reader the parts it holds.
    const trimmedHead = (view.messageWindow?.omittedParts ?? 0) > 0 ? view.messages[0] : undefined;
    for (const row of view.messages) {
      if (row !== trimmedHead && heldRows.has(idOf(row)) && !carry(row)) return null;
    }
  }
  const revised = [...(direct.revisedMessages ?? []), ...carried];
  if (revised.length > NATIVE_AGENT_REVISED_MESSAGES_MAX) return null;
  return {
    ...direct,
    deletedMessageIds: [...deleted],
    ...(revised.length > 0 ? { revisedMessages: revised } : {}),
  };
}
