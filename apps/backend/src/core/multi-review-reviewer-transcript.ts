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
    };

type SnapshotCapable = BuildPipelineProvider &
  Partial<Pick<NativeAgentRuntimeProvider, "transcriptSnapshot" | "transcriptDetail">>;

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
      return readReviewerTranscript(provider, providerSessionId, undefined);
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
    return {
      kind: "snapshot",
      messages: bounded.messages,
      truncated: bounded.truncated || snapshot.complete === false,
      ...(sourceToken ? { sourceToken } : {}),
      fallback: false,
      bytes: bounded.bytes,
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
  return {
    kind: "snapshot",
    messages: bounded.messages,
    // A full window may have had older history the limited read left behind.
    truncated: bounded.truncated || messages.length >= MAX_REVIEWER_TRANSCRIPT_MESSAGES,
    fallback: true,
    bytes: bounded.bytes,
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
