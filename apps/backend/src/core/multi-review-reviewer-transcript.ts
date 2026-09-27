/**
 * Bounded, conditional reads of one reviewer's transcript for its UI tab.
 *
 * The reviewer tab polls while it is visible. Before this module every poll
 * asked the provider for the complete history and sliced the last 500 messages
 * in the backend, so a four-second poll transferred the whole transcript — and
 * then the same 500 messages to the renderer — whether or not anything had
 * changed.
 *
 * Now the read goes to the provider's progressive snapshot surface with an
 * explicit message count and byte target, carrying the source token from the
 * previous response. When the provider says nothing changed, the response
 * carries no messages at all. Providers without that surface fall back to a
 * count-bounded legacy read with a hard byte guard; the fallback is measured so
 * it can be retired, not mistaken for efficient.
 *
 * Where the provider serves lightweight summaries (bridge transcript v2), the
 * read asks for them: large tool bodies, diffs and inline images stay behind
 * the bridge, and each summary part's locator becomes the row's `detailRef`,
 * resolved through `readReviewerToolDetails` only when a row is expanded. A
 * provider that answers raw bodies keeps rendering them inline as before.
 *
 * Source tokens are opaque to the renderer and scoped to the reviewer's
 * provider session: a replaced session never matches an old token, so the
 * renderer always receives a complete bounded snapshot for the new session.
 */
import { createHash } from "node:crypto";
import type { BuildPipelineProvider } from "./build-pipeline-provider.js";
import type { NativeAgentToolDetails } from "@orkestrator/protocol/native-agent";
import {
  BRIDGE_DETAIL_LOCATOR_MAX_LENGTH,
  isBridgeDetailLocator,
  readBridgePartDetail,
} from "@orkestrator/protocol/bridge-transcript-summary";
import type { NativeAgentRuntimeProvider } from "./agent-provider-contract.js";
import {
  DIRECT_HISTORY_CURSOR_MAX_LENGTH,
  decodeHistoryCursor,
  encodeDirectHistoryCursor,
} from "./native-agent-direct-history.js";
import {
  MULTI_REVIEW_HISTORY_EPOCH_MAX_LENGTH,
  MULTI_REVIEW_HISTORY_PAGE_MAX_MESSAGES,
  MULTI_REVIEW_HISTORY_PAGE_MAX_TARGET_BYTES,
} from "@orkestrator/protocol/multi-review";

/** Messages returned to the reviewer tab at most. */
export const MAX_REVIEWER_TRANSCRIPT_MESSAGES = 500;
/** Encoded JSON bytes of the returned messages at most. */
export const MAX_REVIEWER_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
/** Upper bound on an opaque source token, in characters. */
export const MAX_REVIEWER_TRANSCRIPT_TOKEN_LENGTH = 512;

const TOKEN_VERSION = "rt1";

export type ReviewerTranscriptRead =
  | { kind: "unchanged"; sourceToken: string; fallback: false }
  | {
      kind: "snapshot";
      messages: unknown[];
      truncated: boolean;
      sourceToken?: string;
      /** True when the provider had no bounded snapshot surface. */
      fallback: boolean;
      /** Encoded bytes of `messages`. */
      bytes: number;
      /** Cursor for the history before `messages[0]`, when it can be paged. */
      historyCursor?: string;
      /** History continuity epoch; set when the read was given a history key. */
      historyEpoch?: string;
    };

type SnapshotCapable = BuildPipelineProvider &
  Partial<
    Pick<NativeAgentRuntimeProvider, "transcriptSnapshot" | "transcriptDetail" | "transcriptPage">
  >;

const NESTED_PART_FIELDS = ["parts", "childTools", "subagentActions"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Turn a summary part's provider locator into the renderer's `detailRef`.
 * The locator names a message, a part and a digest of its body — nothing the
 * reviewer tab cannot already see — and it is only ever resolved against the
 * reviewer's own provider session.
 */
function displayPart(raw: unknown, depth = 0): unknown {
  if (!isRecord(raw) || depth > 8) return raw;
  const detail = readBridgePartDetail(raw.detail);
  let part: Record<string, unknown> | undefined;
  const writable = () => (part ??= { ...raw });
  if ("detail" in raw) delete writable().detail;
  if (detail) writable().detailRef = detail.locator;
  for (const field of NESTED_PART_FIELDS) {
    const children = raw[field];
    if (!Array.isArray(children)) continue;
    let changed = false;
    const next = children.map((child) => {
      const mapped = displayPart(child, depth + 1);
      if (mapped !== child) changed = true;
      return mapped;
    });
    if (changed) writable()[field] = next;
  }
  if (isRecord(raw.task)) {
    const task = displayPart(raw.task, depth + 1);
    if (task !== raw.task) writable().task = task;
  }
  return part ?? raw;
}

function displayMessage(raw: unknown): unknown {
  if (!isRecord(raw) || !Array.isArray(raw.parts)) return raw;
  let changed = false;
  const parts = raw.parts.map((part) => {
    const mapped = displayPart(part);
    if (mapped !== part) changed = true;
    return mapped;
  });
  return changed ? { ...raw, parts } : raw;
}

/** Session-scoped prefix; never reveals the session identifier itself. */
function sessionScope(providerSessionId: string): string {
  return createHash("sha256").update(providerSessionId).digest("hex").slice(0, 16);
}

function wrapToken(providerSessionId: string, providerToken: string): string | undefined {
  const token = `${TOKEN_VERSION}.${sessionScope(providerSessionId)}.${providerToken}`;
  return token.length <= MAX_REVIEWER_TRANSCRIPT_TOKEN_LENGTH ? token : undefined;
}

/** The provider's token when `token` belongs to this session, else undefined. */
function unwrapToken(providerSessionId: string, token: string | undefined): string | undefined {
  if (!token || token.length > MAX_REVIEWER_TRANSCRIPT_TOKEN_LENGTH) return undefined;
  const prefix = `${TOKEN_VERSION}.${sessionScope(providerSessionId)}.`;
  return token.startsWith(prefix) && token.length > prefix.length
    ? token.slice(prefix.length)
    : undefined;
}

function encodedBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    // An unserializable message cannot be sent to the renderer anyway.
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Keeps the newest messages that fit both bounds. Never cuts a message in the
 * middle: a message that alone exceeds the byte budget is omitted and the
 * response is marked truncated, rather than shipping it whole.
 */
export function boundReviewerTranscript(
  messages: readonly unknown[],
  limits: { maxMessages: number; maxBytes: number } = {
    maxMessages: MAX_REVIEWER_TRANSCRIPT_MESSAGES,
    maxBytes: MAX_REVIEWER_TRANSCRIPT_BYTES,
  },
): { messages: unknown[]; truncated: boolean; bytes: number } {
  const kept: unknown[] = [];
  let bytes = 2; // "[]"
  let truncated = messages.length > limits.maxMessages;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (kept.length >= limits.maxMessages) {
      truncated = true;
      break;
    }
    const size = encodedBytes(messages[index]) + (kept.length > 0 ? 1 : 0);
    if (bytes + size > limits.maxBytes) {
      truncated = true;
      // Older messages cannot be shown without a gap; stop at the first miss.
      break;
    }
    kept.push(messages[index]);
    bytes += size;
  }
  kept.reverse();
  return { messages: kept, truncated, bytes };
}

export async function readReviewerTranscript(
  provider: BuildPipelineProvider,
  providerSessionId: string,
  knownSourceToken: string | undefined,
  /**
   * The reviewer's history identity (`reviewerHistoryKey`). With it, a
   * snapshot that omitted earlier history carries a cursor bound to this
   * reviewer, its provider session and the history epoch.
   */
  history?: { key: string },
): Promise<ReviewerTranscriptRead> {
  const capable = provider as SnapshotCapable;
  if (typeof capable.transcriptSnapshot === "function") {
    const snapshot = await capable.transcriptSnapshot(providerSessionId, {
      limit: MAX_REVIEWER_TRANSCRIPT_MESSAGES,
      targetBytes: MAX_REVIEWER_TRANSCRIPT_BYTES,
      // Details resolve through `readReviewerToolDetails`, so the display can
      // take the lightweight form wherever the provider offers it.
      ...(typeof capable.transcriptDetail === "function"
        ? { representation: "summary" as const }
        : {}),
      ...(unwrapToken(providerSessionId, knownSourceToken)
        ? { knownSourceToken: unwrapToken(providerSessionId, knownSourceToken) }
        : {}),
    });
    if ("unchanged" in snapshot) {
      const sourceToken = wrapToken(providerSessionId, snapshot.sourceToken);
      // An unwrappable token cannot be sent back; answer with a snapshot the
      // renderer can use instead of an unchanged it cannot follow up on.
      if (sourceToken) return { kind: "unchanged", sourceToken, fallback: false };
      return readReviewerTranscript(provider, providerSessionId, undefined, history);
    }
    if (!Array.isArray(snapshot.messages)) {
      throw new Error("The reviewer transcript snapshot was malformed");
    }
    // The provider aims for the target; the backend enforces it. The token
    // still describes the provider's source, so an unchanged answer later
    // correctly means "keep the bounded tail you already have".
    const bounded = boundReviewerTranscript(
      snapshot.representation === "summary"
        ? snapshot.messages.map(displayMessage)
        : snapshot.messages,
    );
    const sourceToken = snapshot.sourceToken
      ? wrapToken(providerSessionId, snapshot.sourceToken)
      : undefined;
    const truncated = bounded.truncated || snapshot.complete === false;
    const historyEpoch = snapshot.historyEpoch ?? LEGACY_HISTORY_EPOCH;
    let historyCursor: string | undefined;
    if (history && truncated && historyEpoch.length <= MULTI_REVIEW_HISTORY_EPOCH_MAX_LENGTH) {
      const owner = { sessionKey: history.key, providerSessionId };
      /*
       * A provider page cursor names the position of the snapshot's first
       * message, so it is usable only while this window still starts there:
       * a byte bound that dropped leading rows would leave a gap no page can
       * fill. Those rows (and providers that cannot page) go through the
       * joined fallback, which pages by message identity instead.
       */
      const direct =
        snapshot.representation === "summary" &&
        snapshot.historyCursor &&
        snapshot.historyEpoch !== undefined &&
        typeof capable.transcriptPage === "function" &&
        bounded.messages.length === snapshot.messages.length
          ? encodeDirectHistoryCursor({
              sessionKey: history.key,
              providerSessionId,
              historyEpoch: snapshot.historyEpoch,
              providerCursor: snapshot.historyCursor,
            })
          : undefined;
      historyCursor =
        direct ??
        joinedCursor(owner, historyEpoch, bounded.messages[0], {
          // Nothing dropped here: only the provider knows older history exists.
          providerIncomplete: !bounded.truncated,
        });
    }
    return {
      kind: "snapshot",
      messages: bounded.messages,
      truncated,
      ...(sourceToken ? { sourceToken } : {}),
      fallback: false,
      bytes: bounded.bytes,
      ...(historyCursor ? { historyCursor } : {}),
      ...(history ? { historyEpoch } : {}),
    };
  }
  // Compatibility path for providers without a bounded snapshot surface. The
  // provider is asked for no more messages than the tab can show, and the
  // response is byte-bounded here; a transport that can only fetch the whole
  // history still slices it before it reaches this module.
  const messages = await provider.messages(providerSessionId, {
    limit: MAX_REVIEWER_TRANSCRIPT_MESSAGES,
  });
  const bounded = boundReviewerTranscript(messages);
  // A full window may have had older history the limited read left behind.
  const truncated = bounded.truncated || messages.length >= MAX_REVIEWER_TRANSCRIPT_MESSAGES;
  const historyCursor =
    history && truncated
      ? joinedCursor(
          { sessionKey: history.key, providerSessionId },
          LEGACY_HISTORY_EPOCH,
          bounded.messages[0],
        )
      : undefined;
  return {
    kind: "snapshot",
    messages: bounded.messages,
    truncated,
    fallback: true,
    bytes: bounded.bytes,
    ...(historyCursor ? { historyCursor } : {}),
    ...(history ? { historyEpoch: LEGACY_HISTORY_EPOCH } : {}),
  };
}

/**
 * The exact body behind a reviewer row's `detailRef`, read from the reviewer's
 * own provider session. The provider checks the body still has the digest the
 * summary described, so this returns that revision or reports it gone.
 */
export async function readReviewerToolDetails(
  provider: BuildPipelineProvider,
  providerSessionId: string,
  detailRef: string,
): Promise<NativeAgentToolDetails> {
  if (detailRef.length > BRIDGE_DETAIL_LOCATOR_MAX_LENGTH || !isBridgeDetailLocator(detailRef)) {
    throw new Error("Reviewer tool detail reference is invalid");
  }
  const capable = provider as SnapshotCapable;
  const result =
    typeof capable.transcriptDetail === "function"
      ? await capable.transcriptDetail(providerSessionId, detailRef)
      : undefined;
  if (!result || result.status === "missing" || result.status === "expired") {
    throw new Error("Reviewer tool details are no longer available");
  }
  if (result.status !== "ok") {
    return { detailRef, toolError: "Tool details exceeded the deferred display limit." };
  }
  return { detailRef, ...result.detail };
}

// ---------------------------------------------------------------------------
// History pages ("load earlier")
//
// The tab shows a bounded newest window; earlier messages are read on demand
// through the same two cursor namespaces native-agent tabs use:
//
// - `v: 2` direct cursors (`native-agent-direct-history.ts`) wrap the
//   provider's own page cursor. A page is one `transcriptPage` call for
//   exactly that range, in summary form, so details stay behind `detailRef`.
// - `v: 1` joined cursors name a message by digest within one history epoch.
//   They serve providers that cannot page (older bridges, OpenCode) from one
//   count-bounded legacy read per page, measured as a fallback.
//
// Both carry digests of the reviewer's history key and provider session. A
// cursor for another reviewer is refused; one for this reviewer's replaced
// session, or for a rewritten history, answers `expired` — never an empty or
// complete page — so the tab resets instead of stitching two histories.

/** Epoch reported for providers that expose no history epoch of their own. */
export const LEGACY_HISTORY_EPOCH = "legacy";
/** Messages a history page returns when the caller does not ask. */
export const REVIEWER_HISTORY_PAGE_DEFAULT_MESSAGES = 100;
/** Byte target of a history page when the caller does not ask. */
export const REVIEWER_HISTORY_PAGE_DEFAULT_BYTES = 512 * 1024;
/**
 * Newest messages a joined-fallback page may search. The fallback reaches no
 * further back than this; beyond it the page ends without a cursor and reports
 * the history incomplete.
 */
export const REVIEWER_HISTORY_FALLBACK_MESSAGES = 2_000;
/** Slack over the byte target a provider page may use for its envelope. */
const PAGE_BYTE_SLACK = 64 * 1024;
/** Upper bound of a joined cursor's message digest. */
const JOINED_BEFORE_MAX_LENGTH = 64;

/** The reviewer's history identity; cursors minted for it name nothing else. */
export function reviewerHistoryKey(workflowId: string, reviewerId: string): string {
  return `multi-review-reviewer\u0000${workflowId}\u0000${reviewerId}`;
}

/** Same digest `native-agent-direct-history.ts` puts in a cursor's `key`/`session`. */
export function reviewerHistoryDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

/** A raw message's identity: flat bridge rows carry `id`, OpenCode rows `info.id`. */
function rawMessageId(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  const id = message.id ?? (isRecord(message.info) ? message.info.id : undefined);
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function messageDigest(id: string): string {
  return createHash("sha256").update(id).digest("base64url").slice(0, 32);
}

interface HistoryOwner {
  sessionKey: string;
  providerSessionId: string;
}

/** A `v: 1` cursor naming the message the next page ends before. */
function joinedCursor(
  owner: HistoryOwner,
  epoch: string,
  first: unknown,
  options: { providerIncomplete?: boolean } = {},
): string | undefined {
  const id = rawMessageId(first);
  if (id === undefined) return undefined;
  const encoded = Buffer.from(
    JSON.stringify({
      v: 1,
      key: reviewerHistoryDigest(owner.sessionKey),
      session: reviewerHistoryDigest(owner.providerSessionId),
      epoch,
      before: messageDigest(id),
      ...(options.providerIncomplete ? { providerIncomplete: true } : {}),
    }),
  ).toString("base64url");
  return encoded.length <= DIRECT_HISTORY_CURSOR_MAX_LENGTH ? encoded : undefined;
}

type ClassifiedCursor =
  | { kind: "direct"; epoch: string; providerCursor: string }
  | { kind: "joined"; epoch: string; before: string; providerIncomplete: boolean }
  | { kind: "session-replaced" }
  | { kind: "foreign" };

function classifyCursor(cursor: string, owner: HistoryOwner): ClassifiedCursor {
  if (cursor.length > DIRECT_HISTORY_CURSOR_MAX_LENGTH) return { kind: "foreign" };
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return { kind: "foreign" };
  }
  if (!isRecord(body) || (body.v !== 1 && body.v !== 2)) return { kind: "foreign" };
  if (body.key !== reviewerHistoryDigest(owner.sessionKey)) return { kind: "foreign" };
  // This reviewer's cursor, minted for a session it no longer runs in.
  if (body.session !== reviewerHistoryDigest(owner.providerSessionId)) {
    return { kind: "session-replaced" };
  }
  if (body.v === 2) {
    const decoded = decodeHistoryCursor(cursor, owner);
    return decoded.version === 2
      ? { kind: "direct", epoch: decoded.epoch, providerCursor: decoded.providerCursor }
      : { kind: "foreign" };
  }
  if (
    typeof body.epoch !== "string" ||
    body.epoch.length === 0 ||
    body.epoch.length > MULTI_REVIEW_HISTORY_EPOCH_MAX_LENGTH ||
    typeof body.before !== "string" ||
    body.before.length === 0 ||
    body.before.length > JOINED_BEFORE_MAX_LENGTH
  ) {
    return { kind: "foreign" };
  }
  return {
    kind: "joined",
    epoch: body.epoch,
    before: body.before,
    providerIncomplete: body.providerIncomplete === true,
  };
}

export type ReviewerHistoryPageRead =
  | {
      kind: "page";
      messages: unknown[];
      historyEpoch: string;
      nextCursor?: string;
      complete: boolean;
      truncated: boolean;
      /** True when the page came from the joined legacy fallback. */
      fallback: boolean;
      bytes: number;
    }
  | { kind: "expired"; reason: "session-replaced" | "history-changed" };

const EXPIRED_HISTORY: ReviewerHistoryPageRead = { kind: "expired", reason: "history-changed" };

function clampPage(options: { limit?: number; targetBytes?: number }) {
  const limit = Math.min(
    options.limit ?? REVIEWER_HISTORY_PAGE_DEFAULT_MESSAGES,
    MULTI_REVIEW_HISTORY_PAGE_MAX_MESSAGES,
  );
  const targetBytes = Math.min(
    options.targetBytes ?? REVIEWER_HISTORY_PAGE_DEFAULT_BYTES,
    MULTI_REVIEW_HISTORY_PAGE_MAX_TARGET_BYTES,
  );
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError("Reviewer history page limit must be a positive integer");
  }
  if (!Number.isSafeInteger(targetBytes) || targetBytes <= 0) {
    throw new RangeError("Reviewer history page byte target must be a positive integer");
  }
  return { limit, targetBytes };
}

/**
 * The reviewer history immediately before `cursor`, read from the reviewer's
 * own provider session.
 *
 * Throws for a cursor that does not belong to this reviewer. Every page either
 * advances (a new `nextCursor`), reaches the start of history (`complete`), or
 * ends explicitly incomplete with no cursor; it never repeats a cursor.
 */
export async function readReviewerHistoryPage(
  provider: BuildPipelineProvider,
  owner: HistoryOwner,
  cursor: string,
  options: { limit?: number; targetBytes?: number } = {},
): Promise<ReviewerHistoryPageRead> {
  const classified = classifyCursor(cursor, owner);
  if (classified.kind === "foreign") {
    throw new Error("Multi review reviewer history cursor does not belong to this reviewer");
  }
  if (classified.kind === "session-replaced") {
    return { kind: "expired", reason: "session-replaced" };
  }
  const { limit, targetBytes } = clampPage(options);
  const capable = provider as SnapshotCapable;

  if (classified.kind === "direct") {
    // The provider connection no longer pages (a bridge replaced by an older
    // one): the cursor cannot be served, and a fresh snapshot mints a joined one.
    if (typeof capable.transcriptPage !== "function") return EXPIRED_HISTORY;
    const page = await capable.transcriptPage(owner.providerSessionId, {
      cursor: classified.providerCursor,
      limit,
      targetBytes,
    });
    if (!page || page.status !== "page" || page.historyEpoch !== classified.epoch) {
      return EXPIRED_HISTORY;
    }
    const messages = page.messages.map(displayMessage);
    const bytes = encodedBytes(messages);
    // The provider bounds its page; one that ignored the bound is refused
    // rather than trimmed, which would lose rows between two cursors.
    if (messages.length > limit || bytes > targetBytes + PAGE_BYTE_SLACK) {
      throw new Error("Reviewer history page exceeded its bound");
    }
    const encoded = page.historyCursor
      ? encodeDirectHistoryCursor({
          ...owner,
          historyEpoch: classified.epoch,
          providerCursor: page.historyCursor,
        })
      : undefined;
    const nextCursor = encoded !== cursor ? encoded : undefined;
    const complete = !page.historyCursor && page.complete;
    return {
      kind: "page",
      messages,
      historyEpoch: classified.epoch,
      ...(nextCursor ? { nextCursor } : {}),
      complete,
      truncated: !complete || page.truncated,
      fallback: false,
      bytes,
    };
  }

  // Joined fallback. The epoch is checked with the same representation the
  // cursor was minted from, so a provider reporting one epoch per read shape
  // cannot expire every cursor it just issued.
  if (classified.epoch !== LEGACY_HISTORY_EPOCH) {
    if (typeof capable.transcriptSnapshot !== "function") return EXPIRED_HISTORY;
    const probe = await capable.transcriptSnapshot(owner.providerSessionId, {
      limit: 1,
      targetBytes: 64 * 1024,
      ...(typeof capable.transcriptDetail === "function"
        ? { representation: "summary" as const }
        : {}),
    });
    if ("unchanged" in probe || probe.historyEpoch !== classified.epoch) return EXPIRED_HISTORY;
  }
  // A provider that keeps a bounded tail (OpenCode) refuses a larger read.
  const windowLimit = Math.min(
    REVIEWER_HISTORY_FALLBACK_MESSAGES,
    provider.messageReadLimit ?? REVIEWER_HISTORY_FALLBACK_MESSAGES,
  );
  const window = await provider.messages(owner.providerSessionId, { limit: windowLimit });
  const end = window.findIndex((message) => {
    const id = rawMessageId(message);
    return id !== undefined && messageDigest(id) === classified.before;
  });
  // The named message is gone: history was rewritten (or it aged past the
  // fallback window). Either way the cursor no longer describes this history.
  if (end < 0) return EXPIRED_HISTORY;
  if (end === 0 && classified.providerIncomplete) {
    // The provider reported older history but returns nothing before this
    // message (it trimmed its own store): unreachable, not complete.
    return {
      kind: "page",
      messages: [],
      historyEpoch: classified.epoch,
      complete: false,
      truncated: true,
      fallback: true,
      bytes: encodedBytes([]),
    };
  }
  const candidates = window.slice(Math.max(0, end - limit), end);
  let bounded = boundReviewerTranscript(candidates, { maxMessages: limit, maxBytes: targetBytes });
  if (bounded.messages.length === 0 && candidates.length > 0) {
    // One message larger than the caller's target: ship it alone if it fits
    // the hard page ceiling, so a click always advances.
    bounded = boundReviewerTranscript(candidates.slice(-1), {
      maxMessages: 1,
      maxBytes: MULTI_REVIEW_HISTORY_PAGE_MAX_TARGET_BYTES,
    });
  }
  const start = end - bounded.messages.length;
  const reachedWindowStart = start === 0;
  const windowFull = window.length >= windowLimit;
  const nextCursor =
    start > 0 && bounded.messages.length > 0
      ? joinedCursor(owner, classified.epoch, bounded.messages[0])
      : undefined;
  const complete = reachedWindowStart && !windowFull;
  return {
    kind: "page",
    messages: bounded.messages,
    historyEpoch: classified.epoch,
    ...(nextCursor ? { nextCursor } : {}),
    complete,
    truncated: !complete,
    fallback: true,
    bytes: bounded.bytes,
  };
}
