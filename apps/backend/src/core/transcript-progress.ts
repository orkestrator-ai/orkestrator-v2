/**
 * Cheap, content-scoped transcript samples for workflow progress supervision.
 *
 * Supervisors decide "slow" versus "wedged" by whether a session's transcript
 * is still moving (see `multi-review-progress.ts`). They used to answer that
 * with `provider.messages({ limit: 1 })`, which an HTTP bridge serves by
 * transferring the whole legacy `/messages` body and slicing it afterwards —
 * megabytes per probe just to hash one tail entry.
 *
 * A sample now comes from the provider's bounded, conditional snapshot:
 *
 * - One message, a small byte target, and the lightweight summary
 *   representation where the bridge serves it. A summary replaces large tool
 *   bodies with detail locators that embed a digest of the body, so a nested
 *   child or tool output that changes inside the tail message still changes
 *   the sample, without the body crossing the wire.
 * - The known source token from the previous sample. `unchanged` means the
 *   provider's source did not move at all, which costs no transcript body.
 * - The digest covers only the tail row and its absolute history position.
 *   The provider's token or revision also advances for usage, title, access
 *   time or freshness changes; none of those is transcript progress, so a new
 *   token with identical content produces the identical digest.
 * - A tail row the byte target had to cut (`omittedParts`) cannot be trusted:
 *   a sub-agent's task part grows by nesting child tools inside it, and a raw
 *   row over the target drops that whole part, so its movement would be
 *   invisible and a working session would look wedged. Such a changed sample
 *   is completed with the exact newest message from the legacy read. That
 *   costs what every probe used to cost, but only when the source moved and
 *   its tail is oversized; unchanged probes stay free, and a summary row only
 *   overflows when it holds very many small parts.
 *
 * Digests are versioned. A version-2 digest carries a comparison base (the
 * representation and history epoch/generation it was taken in) and a content
 * hash. It stays 64 lowercase hex characters — a fixed marker, the base, and
 * the content hash — because every persisted workflow validator, including
 * those of an older backend after a downgrade, accepts exactly that shape.
 * Two digests with different bases are not comparable: a bridge restart,
 * a history reset, a representation change after a bridge upgrade, or a
 * baseline persisted in the older unprefixed format establishes a new base and
 * reports neither progress nor a stall. The durable stall clock
 * (`progressAt` / `startedAt`) keeps running through a rebase exactly as it
 * does through a failed read.
 *
 * Providers without a snapshot surface keep the exact legacy digest of their
 * `messages({ limit: 1 })` tail, so their persisted baselines stay comparable.
 */
import { createHash } from "node:crypto";
import type {
  AgentSessionProvider,
  NativeAgentRuntimeProvider,
  ProviderTranscriptSnapshot,
} from "./agent-provider-contract.js";
import { legacyTranscriptFingerprint } from "./build-pipeline-service-helpers.js";

/** A changing tail entry is enough to detect append and streaming rewrites. */
export const PROGRESS_TRANSCRIPT_TAIL_MESSAGES = 1;
/**
 * Byte target of one progress snapshot. A summary tail row is small by
 * construction; a raw row over it is cut and then completed from the exact
 * tail read (see the module comment).
 */
export const PROGRESS_SNAPSHOT_TARGET_BYTES = 64 * 1024;
/** A longer provider token is not retained; the next sample is then a full snapshot. */
export const MAX_PROGRESS_SOURCE_TOKEN_LENGTH = 1024;

/**
 * Leading marker of a version-2 digest (`7032` is ASCII "p2"). A legacy digest
 * is a uniformly distributed SHA-256, so one begins with this marker with
 * probability 2^-32; it would then merely compare as another base.
 */
const DIGEST_V2_MARKER = "70320d16";
const DIGEST_BASE_HEX = 16;
const DIGEST_CONTENT_HEX = 64 - DIGEST_V2_MARKER.length - DIGEST_BASE_HEX;
/** Comparison base assigned to every older (unmarked) digest. */
const LEGACY_BASE = "legacy";

export type ProgressComparison =
  /** No prior digest: this sample is the first comparison base. */
  | "baseline"
  | "unchanged"
  | "changed"
  /** The prior digest was taken in another base; this sample replaces it. */
  | "rebased";

/** The source token of the previous successful sample, and that sample's digest. */
export interface KnownProgressSource {
  sourceToken: string;
  digest: string;
}

export interface ProgressSample {
  digest: string;
  /** Present when the provider can answer the next sample conditionally. */
  sourceToken?: string;
}

/** How a sample was obtained, for content-free efficiency measurement. */
export type ProgressReadKind = "unchanged" | "snapshot" | "fallback";

type ProgressProvider = Pick<AgentSessionProvider, "messages"> &
  Partial<Pick<NativeAgentRuntimeProvider, "transcriptSnapshot">>;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Fixed-size digest of a `messages()` tail in the original, unprefixed format.
 * Transcript tails may contain megabytes of tool output, prompts, or diffs;
 * none of that content is retained merely to compare the next probe. Digests
 * of this key are already persisted as progress baselines, so the fallback
 * path keeps producing exactly this form.
 */
export function legacyProgressDigest(messages: readonly unknown[]): string {
  return sha256(legacyTranscriptFingerprint(messages));
}

/**
 * Versioned digest of one bounded snapshot: a base naming the representation
 * and history epoch, and a hash of the tail row with its absolute position.
 * Deliberately excludes the source token, revision, title and freshness.
 */
export function snapshotProgressDigest(snapshot: ProviderTranscriptSnapshot): string {
  const base = sha256(
    JSON.stringify([
      snapshot.representation ?? "raw",
      snapshot.generation === undefined ? null : String(snapshot.generation),
      snapshot.historyEpoch ?? null,
    ]),
  ).slice(0, DIGEST_BASE_HEX);
  const tail = snapshot.messages.at(-1);
  const position =
    snapshot.historyStartIndex === undefined
      ? null
      : snapshot.historyStartIndex + snapshot.messages.length;
  const content = sha256(
    JSON.stringify([
      position,
      snapshot.messages.length,
      snapshot.omittedParts ?? 0,
      tail === undefined ? null : tail,
    ]),
  ).slice(0, DIGEST_CONTENT_HEX);
  return `${DIGEST_V2_MARKER}${base}${content}`;
}

function digestBase(digest: string): string {
  return digest.startsWith(DIGEST_V2_MARKER)
    ? digest.slice(0, DIGEST_V2_MARKER.length + DIGEST_BASE_HEX)
    : LEGACY_BASE;
}

/** How `next` relates to the prior comparison base, if there is one. */
export function compareProgressDigests(
  prior: string | undefined,
  next: string,
): ProgressComparison {
  if (prior === undefined) return "baseline";
  if (prior === next) return "unchanged";
  return digestBase(prior) === digestBase(next) ? "changed" : "rebased";
}

/**
 * Apply one sample to a durable clock that has no tracker (the looped-review
 * structured wait). A first sample and a change move `progressAt`, as before;
 * a rebase only replaces the digest, so an upgrade or a bridge restart neither
 * resets nor advances the stall clock.
 */
export function applyProgressSample(
  clock: { progressDigest?: string; progressAt?: string },
  digest: string,
  now: string,
): ProgressComparison {
  const comparison = compareProgressDigests(clock.progressDigest, digest);
  if (comparison === "unchanged") return comparison;
  clock.progressDigest = digest;
  if (comparison !== "rebased") clock.progressAt = now;
  return comparison;
}

function retainableToken(token: unknown): string | undefined {
  return typeof token === "string" &&
    token.length > 0 &&
    token.length <= MAX_PROGRESS_SOURCE_TOKEN_LENGTH
    ? token
    : undefined;
}

/** Whether samples for this provider come from its bounded snapshot surface. */
export function hasProgressSnapshot(provider: object): boolean {
  return typeof (provider as ProgressProvider).transcriptSnapshot === "function";
}

/**
 * Read one progress sample. Rejects when nothing was learned — a failed read,
 * a malformed snapshot, or an `unchanged` answer with nothing to compare it to
 * — so callers keep treating a rejection as "nothing learned".
 *
 * `fallbackRead` replaces the default `messages({ limit: 1 })` — for providers
 * without a snapshot surface, and to complete a cut tail row — letting a
 * caller share a read it needs anyway. It must end with the newest message.
 */
export async function readTranscriptProgressSample(input: {
  provider: ProgressProvider;
  sessionId: string;
  known?: KnownProgressSource;
  fallbackRead?: () => Promise<unknown[]>;
  onRead?: (kind: ProgressReadKind) => void;
}): Promise<ProgressSample> {
  const { provider, sessionId, known } = input;
  if (typeof provider.transcriptSnapshot === "function") {
    const snapshot = await provider.transcriptSnapshot(sessionId, {
      limit: PROGRESS_TRANSCRIPT_TAIL_MESSAGES,
      targetBytes: PROGRESS_SNAPSHOT_TARGET_BYTES,
      ...(known ? { knownSourceToken: known.sourceToken } : {}),
      representation: "summary",
    });
    if ("unchanged" in snapshot) {
      // Only a token this caller sent can be confirmed; anything else is not
      // a comparison, and must not become a baseline.
      if (!known) throw new Error("Unexpected unchanged transcript without a known source");
      input.onRead?.("unchanged");
      const sourceToken = retainableToken(snapshot.sourceToken);
      return { digest: known.digest, ...(sourceToken ? { sourceToken } : {}) };
    }
    if (!Array.isArray(snapshot.messages)) {
      throw new Error("The transcript progress snapshot was malformed");
    }
    input.onRead?.("snapshot");
    const sourceToken = retainableToken(snapshot.sourceToken);
    let sampled = snapshot;
    if ((snapshot.omittedParts ?? 0) > 0 && snapshot.messages.length > 0) {
      // The byte target cut the tail row, so parts that can still move were
      // not seen. Hash the exact newest message instead, at the snapshot's
      // position and base; an untrimmed row hashes the same way, so samples
      // stay comparable as the row grows past the target and back.
      const exact = (await tailRead(input)).at(-1);
      if (exact === undefined) throw new Error("The exact transcript tail was unavailable");
      input.onRead?.("fallback");
      sampled = { ...snapshot, messages: [...snapshot.messages.slice(0, -1), exact] };
      delete sampled.omittedParts;
    }
    return { digest: snapshotProgressDigest(sampled), ...(sourceToken ? { sourceToken } : {}) };
  }
  const messages = await tailRead(input);
  input.onRead?.("fallback");
  return { digest: legacyProgressDigest(messages.slice(-PROGRESS_TRANSCRIPT_TAIL_MESSAGES)) };
}

/** The newest message through the caller's shared read, or a one-message legacy read. */
function tailRead(input: {
  provider: ProgressProvider;
  sessionId: string;
  fallbackRead?: () => Promise<unknown[]>;
}): Promise<unknown[]> {
  return input.fallbackRead
    ? input.fallbackRead()
    : input.provider.messages(input.sessionId, { limit: PROGRESS_TRANSCRIPT_TAIL_MESSAGES });
}
