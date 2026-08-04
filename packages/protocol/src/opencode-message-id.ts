const OPEN_CODE_TIME_HEX_LENGTH = 12;
const OPEN_CODE_RANDOM_LENGTH = 14;
const ORKESTRATOR_SEQUENCE_HEX_LENGTH = 12;
const MAX_ORKESTRATOR_SEQUENCE = 0xffffffffffffn;
const TIME_MASK = 0xffffffffffffn;

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
  const match = /^(?:msg|ses)_([0-9a-f]{12})/i.exec(id);
  return match?.[1]?.toLowerCase();
}

function fallbackTimeHex(now: number): string {
  const milliseconds = Number.isFinite(now) && now >= 0 ? Math.floor(now) : 0;
  return ((BigInt(milliseconds) * 0x1000n) & TIME_MASK)
    .toString(16)
    .padStart(OPEN_CODE_TIME_HEX_LENGTH, "0");
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
  sessionId: string,
  entries: readonly unknown[],
  requestId: string,
  now: number = Date.now(),
): string {
  const existing = findOpenCodeMessageId(entries, requestId);
  if (existing) return existing;

  const marker = openCodeRequestMarker(requestId);
  const ids: string[] = [];
  if (typeof sessionId === "string") ids.push(sessionId);
  for (const entry of entries) {
    const info = messageInfo(entry);
    if (!info) continue;
    if (typeof info.id === "string") ids.push(info.id);
    if (typeof info.parentID === "string") ids.push(info.parentID);
  }

  const prefixes = ids.map(timeHex).filter((value): value is string => value !== undefined);
  const anchor = prefixes.length > 0
    ? prefixes.reduce((latest, candidate) => candidate > latest ? candidate : latest)
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
