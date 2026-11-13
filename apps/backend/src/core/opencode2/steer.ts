/**
 * Steering on OpenCode 2.x, from what the pinned 2.2.6 server was observed to
 * do (`scripts/opencode2-steer-probe.ts`; to-do 0008, retired (`git show 17d28238c:docs/todo/agent-engines/0008-opencode-v2.md`)
 * task 10):
 *
 * - `POST /api/session/:id/prompt` with `delivery: "steer"` delivers at the
 *   next safe step boundary of the running run, or, if the run has ended,
 *   starts a new run. That is Orkestrator's rule for every provider: a steer
 *   that misses its turn becomes a new turn (0005 task 10).
 * - The input id is the idempotency key, and must match `^msg_`. Re-sending
 *   the same id with the same text answers the original record. Re-sending it
 *   with *different* text also answers the original record, silently dropping
 *   the new text, so an admission is checked against what was sent.
 * - Each settled run appends an `idle` row to the message history, which is
 *   how a snapshot tells which run a steer landed in.
 */
import type { OpenCode2Message } from "./types.js";
import { isOpenCode2IdleMessage, isOpenCode2UserMessage } from "./types.js";

const ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ID_LENGTH = 26;
let lastTimestamp = 0;
let counter = 0;

/**
 * Mint a message input id in OpenCode's own ascending format
 * (`packages/schema/src/identifier.ts`: 12 hex digits of
 * `timestamp * 0x1000 + counter`, then 14 base62 characters), so history
 * ordered by id stays ordered by time. The id is minted once per Orkestrator
 * request and journaled with it; a retry reuses the journaled id.
 */
export function mintOpenCode2InputId(
  timestamp = Date.now(),
  random: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes),
): string {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    counter = 0;
  }
  counter++;
  const value = BigInt(timestamp) * 0x1000n + BigInt(counter);
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0"),
  ).join("");
  const bytes = random(new Uint8Array(ID_LENGTH - 12));
  return `msg_${time}${Array.from(bytes, (byte) => ID_CHARS[byte % 62]).join("")}`;
}

export function isOpenCode2InputId(value: unknown): value is string {
  return typeof value === "string" && /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(value);
}

export type OpenCode2Admission =
  | { kind: "admitted" }
  /** The id already named different input; the text sent was dropped. */
  | { kind: "conflict" }
  /** The answer cannot be read as either; treat delivery as unknown. */
  | { kind: "unrecognized" };

/**
 * Check a prompt answer against the input that was sent. 2.2.6 answers a
 * conflicting reuse of an id with the *original* record and status 200, so
 * only the payload shows the conflict.
 */
export function checkOpenCode2Admission(
  answer: unknown,
  sent: { id: string; text: string },
): OpenCode2Admission {
  if (!answer || typeof answer !== "object") return { kind: "unrecognized" };
  const record = answer as { id?: unknown; payload?: { text?: unknown }; text?: unknown };
  if (record.id !== sent.id) return { kind: "unrecognized" };
  const text =
    typeof record.payload?.text === "string"
      ? record.payload.text
      : typeof record.text === "string"
        ? record.text
        : undefined;
  if (text === undefined) return { kind: "unrecognized" };
  return text === sent.text ? { kind: "admitted" } : { kind: "conflict" };
}

export type OpenCode2SteerLanding =
  /** Not in history yet: still in the inbox, or the page did not reach it. */
  | "pending"
  /** Delivered inside the run it was aimed at. */
  | "same-run"
  /** A run settled before delivery, so the steer started a new run. */
  | "new-run"
  /** The page does not hold the anchor, so the two cannot be compared. */
  | "unknown";

/**
 * Where a steer landed, read from a history page (oldest first) that holds
 * it. `anchorIdleId` is the newest `idle` row the provider had seen when it
 * sent the steer (absent when the session had never settled a run). The steer
 * is in its intended run when no `idle` row lies between the anchor and it.
 */
export function classifyOpenCode2SteerLanding(
  messagesOldestFirst: readonly OpenCode2Message[],
  inputId: string,
  anchorIdleId: string | undefined,
): OpenCode2SteerLanding {
  const at = messagesOldestFirst.findIndex(
    (message) => isOpenCode2UserMessage(message) && message.id === inputId,
  );
  if (at < 0) return "pending";
  let from = 0;
  if (anchorIdleId !== undefined) {
    const anchor = messagesOldestFirst.findIndex((message) => message.id === anchorIdleId);
    if (anchor < 0 || anchor > at) return "unknown";
    from = anchor + 1;
  }
  return messagesOldestFirst.slice(from, at).some(isOpenCode2IdleMessage) ? "new-run" : "same-run";
}

/** The newest `idle` row in a page (oldest first), the anchor for the next steer. */
export function newestOpenCode2IdleId(
  messagesOldestFirst: readonly OpenCode2Message[],
): string | undefined {
  for (let index = messagesOldestFirst.length - 1; index >= 0; index--) {
    const message = messagesOldestFirst[index]!;
    if (isOpenCode2IdleMessage(message)) return message.id;
  }
  return undefined;
}
