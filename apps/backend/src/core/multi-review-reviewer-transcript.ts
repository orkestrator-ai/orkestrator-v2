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
 * carries no messages at all. Providers without that surface fall back to the
 * legacy read with a hard byte guard; the fallback is measured so it can be
 * retired, not mistaken for efficient.
 *
 * Source tokens are opaque to the renderer and scoped to the reviewer's
 * provider session: a replaced session never matches an old token, so the
 * renderer always receives a complete bounded snapshot for the new session.
 */
import { createHash } from "node:crypto";
import type { BuildPipelineProvider } from "./build-pipeline-provider.js";
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
  Partial<Pick<NativeAgentRuntimeProvider, "transcriptSnapshot">>;

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
    const bounded = boundReviewerTranscript(snapshot.messages);
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
  // read itself is unbounded at the provider; only the response is bounded.
  const bounded = boundReviewerTranscript(await provider.messages(providerSessionId));
  return {
    kind: "snapshot",
    messages: bounded.messages,
    truncated: bounded.truncated,
    fallback: true,
    bytes: bounded.bytes,
  };
}
