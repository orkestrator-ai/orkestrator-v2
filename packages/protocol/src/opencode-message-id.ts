const OPEN_CODE_TIME_HEX_LENGTH = 12;
const OPEN_CODE_RANDOM_LENGTH = 14;
const ORKESTRATOR_SEQUENCE_HEX_LENGTH = 12;
const MAX_ORKESTRATOR_SEQUENCE = 0xffffffffffffn;
const TIME_MASK = 0xffffffffffffn;
const TIME_HALF_RANGE = 0x800000000000n;

/** Maximum newest messages read before a caller-owned dispatch. */
export const OPEN_CODE_MESSAGE_HISTORY_LIMIT = 64;
/**
 * Parsed history is also bounded by serialized size. This is deliberately
 * larger than the product's aggregate attachment allowance so one legitimate
 * attachment-bearing turn cannot strand its session.
 */
export const OPEN_CODE_MESSAGE_HISTORY_MAX_BYTES = 64 * 1024 * 1024;
export const OPEN_CODE_MESSAGE_ID_MAX_SESSIONS = 128;
export const OPEN_CODE_MESSAGE_ID_MAX_RESERVATIONS_PER_SESSION = 64;

interface OpenCodeMessageIdSessionState {
  tail: Promise<void>;
  pending: number;
  reservations: Map<string, {
    messageId: string;
    accepted: boolean;
  }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageInfo(entry: unknown): Record<string, unknown> | undefined {
  if (!isRecord(entry) || !isRecord(entry.info)) return undefined;
  return entry.info;
}

function encodeRequestId(requestId: string): string {
  if (requestId.trim().length === 0) {
    throw new TypeError("OpenCode request ID must be a non-empty string");
  }
  let encoded = "";
  for (let index = 0; index < requestId.length; index += 1) {
    encoded += requestId.charCodeAt(index).toString(16).padStart(4, "0");
  }
  return encoded;
}

/**
 * Stable, injective marker appended to caller-owned OpenCode message IDs.
 * Keeping it at the end lets a restarted process recover the provider ID from
 * authoritative message history without maintaining a second durable journal.
 */
export function openCodeRequestMarker(requestId: string): string {
  return `_ork_${encodeRequestId(requestId)}`;
}

function timeHex(id: string): string | undefined {
  // Session IDs are descending (bitwise-complemented) while message IDs are
  // ascending. Their prefixes must never share one chronological domain.
  const match = /^msg_([0-9a-f]{12})/i.exec(id);
  return match?.[1]?.toLowerCase();
}

function fallbackTimeHex(now: number): string {
  const milliseconds = Number.isFinite(now) && now >= 0 ? Math.floor(now) : 0;
  return ((BigInt(milliseconds) * 0x1000n) & TIME_MASK)
    .toString(16)
    .padStart(OPEN_CODE_TIME_HEX_LENGTH, "0");
}

function laterTimeHex(current: string, candidate: string): string {
  const currentValue = BigInt(`0x${current}`);
  const candidateValue = BigInt(`0x${candidate}`);
  const forwardDistance = (candidateValue - currentValue) & TIME_MASK;
  // OpenCode stores only 48 bits of its ascending millisecond/counter value,
  // which wraps roughly every 795 days. Modular comparison keeps IDs on the
  // new side of that boundary newer than prefixes just before the wrap.
  return forwardDistance > 0n && forwardDistance < TIME_HALF_RANGE
    ? candidate
    : current;
}

/** Find a previously materialized user-message ID for one durable request. */
export function findOpenCodeMessageId(
  entries: readonly unknown[],
  requestId: string,
): string | undefined {
  const marker = openCodeRequestMarker(requestId);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const info = messageInfo(entries[index]);
    if (!info) continue;
    if (
      info.role === "user"
      && typeof info.id === "string"
      && info.id.startsWith("msg_")
      && info.id.endsWith(marker)
    ) {
      return info.id;
    }
    // A completed assistant is also authoritative evidence of the user ID.
    // This keeps reconciliation robust when a compacted transcript omits the
    // original user entry but retains the assistant's parent relationship.
    if (
      info.role === "assistant"
      && typeof info.parentID === "string"
      && info.parentID.startsWith("msg_")
      && info.parentID.endsWith(marker)
    ) {
      return info.parentID;
    }
  }
  return undefined;
}

function jsonStringBytes(value: string): number {
  let bytes = 2; // opening and closing quotes
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f) {
      // JSON may use a two-byte short escape, but six is the safe upper bound.
      bytes += 6;
    } else if (code === 0x22 || code === 0x5c) {
      bytes += 2;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function isWithinJsonByteLimit(value: unknown, maximumBytes: number): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let bytes = 0;
  let nodes = 0;

  const add = (count: number): boolean => {
    bytes += count;
    return bytes <= maximumBytes;
  };

  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > 1_000_000 || current.depth > 64) return false;
    const item = current.value;
    if (item === null) {
      if (!add(4)) return false;
    } else if (typeof item === "string") {
      if (!add(jsonStringBytes(item))) return false;
    } else if (typeof item === "number") {
      if (!add(Number.isFinite(item) ? String(item).length : 4)) return false;
    } else if (typeof item === "boolean") {
      if (!add(item ? 4 : 5)) return false;
    } else if (typeof item === "object") {
      if (seen.has(item)) return false;
      seen.add(item);
      if (Array.isArray(item)) {
        if (!add(2 + Math.max(0, item.length - 1))) return false;
        for (let index = item.length - 1; index >= 0; index -= 1) {
          stack.push({ value: item[index] ?? null, depth: current.depth + 1 });
        }
      } else {
        const entries = Object.entries(item);
        if (!add(2 + Math.max(0, entries.length - 1))) return false;
        for (let index = entries.length - 1; index >= 0; index -= 1) {
          const [key, entry] = entries[index]!;
          if (!add(jsonStringBytes(key) + 1)) return false;
          stack.push({ value: entry, depth: current.depth + 1 });
        }
      }
    } else {
      // SDK responses are parsed JSON; other JavaScript values are malformed.
      return false;
    }
  }
  return true;
}

export function boundedOpenCodeMessageHistory(
  value: unknown,
  limits: { count?: number; bytes?: number } = {},
): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError("OpenCode returned malformed message history before dispatch");
  }
  const maximumCount = limits.count ?? OPEN_CODE_MESSAGE_HISTORY_LIMIT;
  const maximumBytes = limits.bytes ?? OPEN_CODE_MESSAGE_HISTORY_MAX_BYTES;
  if (
    !Number.isSafeInteger(maximumCount)
    || maximumCount < 0
    || !Number.isSafeInteger(maximumBytes)
    || maximumBytes < 0
  ) {
    throw new RangeError("OpenCode message history bounds must be non-negative integers");
  }
  if (value.length > maximumCount) {
    throw new RangeError("OpenCode returned too many messages before dispatch");
  }
  if (!isWithinJsonByteLimit(value, maximumBytes)) {
    throw new RangeError("OpenCode returned oversized message history before dispatch");
  }
  return value;
}

/**
 * Resolve a retry-stable OpenCode message ID that sorts after every materialized
 * message and before the next server-generated message.
 *
 * OpenCode's first 12 message-ID characters encode a global timestamp/counter.
 * We reuse the latest authoritative prefix and place a 14-character maximum
 * base62 suffix after it. A bounded secondary sequence orders multiple accepted
 * caller messages that share that prefix. The server's next ID increments the
 * timestamp/counter prefix, so its assistant response still sorts after ours.
 */
export function resolveOpenCodeMessageId(
  entries: readonly unknown[],
  requestId: string,
  now: number = Date.now(),
  reservations: readonly string[] = [],
): string {
  const existing = findOpenCodeMessageId(entries, requestId);
  if (existing) return existing;

  const marker = openCodeRequestMarker(requestId);
  const ids: string[] = [...reservations];
  for (const entry of entries) {
    const info = messageInfo(entry);
    if (!info) continue;
    if (typeof info.id === "string") ids.push(info.id);
    if (typeof info.parentID === "string") ids.push(info.parentID);
  }

  const prefixes = ids.map(timeHex).filter((value): value is string => value !== undefined);
  const anchor = prefixes.length > 0
    ? prefixes.reduce(laterTimeHex)
    : fallbackTimeHex(now);

  const customPrefix = `msg_${anchor}${"z".repeat(OPEN_CODE_RANDOM_LENGTH)}`;
  let sequence = 0n;
  for (const id of ids) {
    if (!id.startsWith(customPrefix)) continue;
    const encoded = id.slice(
      customPrefix.length,
      customPrefix.length + ORKESTRATOR_SEQUENCE_HEX_LENGTH,
    );
    if (!/^[0-9a-f]{12}$/i.test(encoded)) continue;
    const candidate = BigInt(`0x${encoded}`);
    if (candidate > sequence) sequence = candidate;
  }
  if (sequence >= MAX_ORKESTRATOR_SEQUENCE) {
    throw new RangeError("OpenCode caller-owned message sequence is exhausted");
  }
  const nextSequence = (sequence + 1n)
    .toString(16)
    .padStart(ORKESTRATOR_SEQUENCE_HEX_LENGTH, "0");
  return `${customPrefix}${nextSequence}${marker}`;
}

/**
 * Serializes caller-owned allocation through dispatch for one OpenCode session
 * and retains a bounded set of allocations until authoritative history catches
 * up. Callers must keep the history read and provider dispatch inside
 * `runExclusive` so two requests cannot reserve in one order and send in
 * another.
 */
export class OpenCodeMessageIdCoordinator {
  private readonly sessions = new Map<string, OpenCodeMessageIdSessionState>();

  constructor(
    private readonly maximumSessions = OPEN_CODE_MESSAGE_ID_MAX_SESSIONS,
    private readonly maximumReservations = OPEN_CODE_MESSAGE_ID_MAX_RESERVATIONS_PER_SESSION,
  ) {
    if (!Number.isSafeInteger(maximumSessions) || maximumSessions <= 0) {
      throw new RangeError("OpenCode message-ID session limit must be positive");
    }
    if (!Number.isSafeInteger(maximumReservations) || maximumReservations <= 0) {
      throw new RangeError("OpenCode message-ID reservation limit must be positive");
    }
  }

  private state(sessionId: string): OpenCodeMessageIdSessionState {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      this.sessions.delete(sessionId);
      this.sessions.set(sessionId, existing);
      return existing;
    }
    if (this.sessions.size >= this.maximumSessions) {
      const evictable = [...this.sessions].find(([, state]) =>
        state.pending === 0
        && [...state.reservations.values()].every((reservation) => reservation.accepted)
      );
      if (!evictable) {
        throw new RangeError("OpenCode message-ID session capacity is exhausted");
      }
      this.sessions.delete(evictable[0]);
    }
    const created: OpenCodeMessageIdSessionState = {
      tail: Promise.resolve(),
      pending: 0,
      reservations: new Map(),
    };
    this.sessions.set(sessionId, created);
    return created;
  }

  async runExclusive<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const state = this.state(sessionId);
    const prior = state.tail;
    let release: () => void = () => undefined;
    state.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    state.pending += 1;
    await prior;
    try {
      return await operation();
    } finally {
      state.pending -= 1;
      release();
    }
  }

  resolve(
    sessionId: string,
    entries: readonly unknown[],
    requestId: string,
    now: number = Date.now(),
  ): string {
    const state = this.state(sessionId);
    for (const reservedRequestId of [...state.reservations.keys()]) {
      if (findOpenCodeMessageId(entries, reservedRequestId)) {
        state.reservations.delete(reservedRequestId);
      }
    }
    const materialized = findOpenCodeMessageId(entries, requestId);
    if (materialized) {
      return materialized;
    }
    const reserved = state.reservations.get(requestId);
    if (reserved) {
      state.reservations.delete(requestId);
      state.reservations.set(requestId, reserved);
      return reserved.messageId;
    }
    if (state.reservations.size >= this.maximumReservations) {
      throw new RangeError("OpenCode message-ID reservation capacity is exhausted");
    }
    const messageId = resolveOpenCodeMessageId(
      entries,
      requestId,
      now,
      [...state.reservations.values()].map(({ messageId }) => messageId),
    );
    state.reservations.set(requestId, { messageId, accepted: false });
    return messageId;
  }

  /**
   * Mark a reservation as durably accepted by OpenCode. It remains available
   * for an immediate same-process retry, but its idle session can be evicted
   * under the global bound because a later retry can recover it from history.
   */
  markAccepted(sessionId: string, requestId: string): void {
    const reservation = this.sessions.get(sessionId)?.reservations.get(requestId);
    if (reservation) reservation.accepted = true;
  }
}
