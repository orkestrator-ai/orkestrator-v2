/**
 * Detail references of inline bodies, memoized per part.
 *
 * A tool body, a large input value or finished reasoning moves behind a
 * detail reference minted from a SHA-256 of the body's JSON. The projected
 * row cache (`native-agent-projection-entries.ts`) spares an unchanged row
 * that work, but a streaming row misses it on every read, and then every part
 * on it was serialized and hashed again although only the newest one changed.
 *
 * Bridges parse fresh objects on every read, so object identity cannot key
 * this memo. As the row cache does, an entry answers only when the incoming
 * body is structurally equal to a private copy taken when the entry was made,
 * for the same session, message and part path and the same image path: every
 * input the reference is minted from. A hit is therefore always the reference
 * a fresh hash would produce. Strings are shared with the provider's copy,
 * not duplicated, but are counted at full length so the bounds hold even when
 * nothing else retains them.
 *
 * The memo only saves the hash and the serialization. The caller still
 * registers the reference with the detail cache and the row's registrations
 * on a hit, so an evicted body is restored and a reused row can replay it.
 */
import { createHash } from "node:crypto";
import { copyProjectionSource, sameProjectionSource } from "./native-agent-projection-entries.js";

export interface ToolDetailEncoding {
  detailRef: string;
  /** UTF-8 bytes of the body's JSON. */
  serializedBytes: number;
}

export interface ToolDetailMemoLimits {
  maxEntries: number;
  maxBytes: number;
  /** Larger bodies are hashed on every read rather than admitted. */
  maxEntryBytes: number;
}

export const NATIVE_TOOL_DETAIL_MEMO_LIMITS: ToolDetailMemoLimits = {
  maxEntries: 4_096,
  maxBytes: 32 * 1024 * 1024,
  // A deferred inline image may be 16 MiB, and is the most costly to re-hash.
  maxEntryBytes: 17 * 1024 * 1024,
};

/** Rough allowance for an entry's bookkeeping beyond its copy and key. */
const ENTRY_OVERHEAD_BYTES = 128;

interface MemoEntry {
  sessionKey: string;
  copy: unknown;
  localImagePath: string;
  encoding: ToolDetailEncoding;
  bytes: number;
}

export class ToolDetailEncodingMemo {
  private readonly entries = new Map<string, MemoEntry>();
  private totalBytes = 0;
  private hitCount = 0;

  constructor(private readonly limits: ToolDetailMemoLimits) {}

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  /** Answers served without serializing or hashing; for tests. */
  get hits(): number {
    return this.hitCount;
  }

  /** The reference and size of an inline body, from the memo when it is unchanged. */
  encode(
    sessionKey: string,
    messageId: string,
    partPath: string,
    details: object,
    localImagePath = "",
  ): ToolDetailEncoding {
    const key = `${sessionKey}\0${messageId}\0${partPath}`;
    const held = this.entries.get(key);
    if (
      held &&
      held.localImagePath === localImagePath &&
      sameProjectionSource(details, held.copy)
    ) {
      this.entries.delete(key);
      this.entries.set(key, held);
      this.hitCount += 1;
      return held.encoding;
    }
    const serialized = JSON.stringify(details);
    const encoding: ToolDetailEncoding = {
      detailRef: createHash("sha256")
        .update(`${sessionKey}\0${messageId}\0${partPath}\0${serialized}\0${localImagePath}`)
        .digest("hex")
        .slice(0, 32),
      serializedBytes: Buffer.byteLength(serialized),
    };
    this.store(key, sessionKey, details, localImagePath, encoding);
    return encoding;
  }

  private store(
    key: string,
    sessionKey: string,
    details: object,
    localImagePath: string,
    encoding: ToolDetailEncoding,
  ): void {
    this.delete(key);
    const source = copyProjectionSource(details);
    if (!source) return;
    const bytes =
      source.bytes +
      key.length +
      localImagePath.length +
      encoding.detailRef.length +
      ENTRY_OVERHEAD_BYTES;
    if (
      this.limits.maxEntries <= 0 ||
      bytes > this.limits.maxEntryBytes ||
      bytes > this.limits.maxBytes
    ) {
      return;
    }
    this.entries.set(key, { sessionKey, copy: source.copy, localImagePath, encoding, bytes });
    this.totalBytes += bytes;
    while (this.entries.size > this.limits.maxEntries || this.totalBytes > this.limits.maxBytes) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }

  private delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.totalBytes -= entry.bytes;
  }

  /** Drop a logical session's entries: its history was replaced. */
  forgetSession(sessionKey: string): void {
    for (const [key, entry] of Array.from(this.entries)) {
      if (entry.sessionKey === sessionKey) this.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }
}
