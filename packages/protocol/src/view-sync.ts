/**
 * Revision contracts for event-led views recovered from authoritative snapshots.
 *
 * Several client views are a live event stream folded over an authoritative
 * snapshot (PR monitor, diff statistics, and later file lists, trees and the
 * coordinator view). Each such view is owned by one backend component, and that
 * owner — not the transport — defines the ordering a client may rely on:
 *
 * - `generation` identifies one lifetime of the owning component. It changes
 *   when the owner is recreated (backend restart, service replacement, target
 *   retargeted to a different lineage). Revisions from different generations
 *   are unrelated counters and must never be compared.
 * - `revision` is the owner's domain revision. Within one generation it
 *   increases by exactly one for every change the owner announces, so a gap
 *   in the sequence a client observes is evidence of a missed change. Revision
 *   `0` means "nothing announced yet" and is only valid on snapshots.
 *
 * These are deliberately separate from the gateway's global replay revision
 * (which is filtered per subscription and therefore has intentional gaps) and
 * from resource-manifest revisions (opaque digests of persistent resources).
 * See `docs/architecture/event-snapshot-recovery.md`.
 *
 * Every field is additive. A peer that omits the stamp is a legacy peer: its
 * snapshots and events remain valid, and the client falls back to conservative
 * reconnect hydration rather than revision-aware convergence.
 */

/** Opaque owner generation. Printable, bounded, compared only for equality. */
export type ViewGeneration = string;

/** Owner-scoped ordering for one announced change or one captured snapshot. */
export interface ViewRevisionStamp {
  generation: ViewGeneration;
  revision: number;
}

/** Upper bound for a generation token; generous for UUIDs and hex digests. */
export const VIEW_GENERATION_MAX_LENGTH = 128;

const GENERATION_PATTERN = /^[A-Za-z0-9._:-]+$/;

export function isViewGeneration(value: unknown): value is ViewGeneration {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= VIEW_GENERATION_MAX_LENGTH &&
    GENERATION_PATTERN.test(value)
  );
}

/** A snapshot revision: a non-negative safe integer (`0` = nothing announced). */
export function isViewSnapshotRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** An event revision: a positive safe integer. */
export function isViewEventRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

/**
 * Reads the optional `generation`/`revision` pair from a payload.
 *
 * - `null`: both fields are absent — a legacy peer.
 * - a stamp: both fields are present and valid.
 * - `"invalid"`: one field is missing or malformed. Callers reject the whole
 *   payload rather than silently treating a corrupt stamp as legacy.
 */
export function readViewRevisionStamp(
  value: unknown,
  kind: "event" | "snapshot",
): ViewRevisionStamp | null | "invalid" {
  if (typeof value !== "object" || value === null) return "invalid";
  const candidate = value as Record<string, unknown>;
  const hasGeneration = candidate.generation !== undefined;
  const hasRevision = candidate.revision !== undefined;
  if (!hasGeneration && !hasRevision) return null;
  if (!hasGeneration || !hasRevision) return "invalid";
  if (!isViewGeneration(candidate.generation)) return "invalid";
  const validRevision =
    kind === "event"
      ? isViewEventRevision(candidate.revision)
      : isViewSnapshotRevision(candidate.revision);
  if (!validRevision) return "invalid";
  return { generation: candidate.generation, revision: candidate.revision as number };
}

/** True when the optional stamp on a payload is absent or well formed. */
export function hasValidOptionalViewStamp(value: unknown, kind: "event" | "snapshot"): boolean {
  return readViewRevisionStamp(value, kind) !== "invalid";
}

// ---------------------------------------------------------------------------
// Conditional snapshot requests and outcomes
// ---------------------------------------------------------------------------

/**
 * Arguments a client adds to a snapshot command to ask for a conditional read.
 *
 * The client must send the revision it is *contiguously* caught up to, not the
 * highest revision it has seen: after a gap the highest seen revision would let
 * the owner answer `unchanged` while a change is still missing.
 */
export interface ViewSnapshotRequestArgs {
  knownGeneration: ViewGeneration;
  knownRevision: number;
}

export type ParsedViewSnapshotRequest =
  | { kind: "absent" }
  | { kind: "known"; known: ViewRevisionStamp }
  | { kind: "invalid" };

/** Validates conditional-read arguments at the command boundary. */
export function parseViewSnapshotRequest(args: unknown): ParsedViewSnapshotRequest {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return { kind: "absent" };
  const candidate = args as Record<string, unknown>;
  const hasGeneration = candidate.knownGeneration !== undefined;
  const hasRevision = candidate.knownRevision !== undefined;
  if (!hasGeneration && !hasRevision) return { kind: "absent" };
  if (
    !hasGeneration ||
    !hasRevision ||
    !isViewGeneration(candidate.knownGeneration) ||
    !isViewSnapshotRevision(candidate.knownRevision)
  ) {
    return { kind: "invalid" };
  }
  return {
    kind: "known",
    known: { generation: candidate.knownGeneration, revision: candidate.knownRevision },
  };
}

export function toViewSnapshotRequestArgs(known: ViewRevisionStamp): ViewSnapshotRequestArgs {
  return { knownGeneration: known.generation, knownRevision: known.revision };
}

/**
 * Authoritative answer to a conditional snapshot read.
 *
 * - `unchanged`: the owner is still at the client's known generation and
 *   revision. No body is sent; the client keeps its state.
 * - `snapshot`: same generation, newer revision. The body replaces the view.
 * - `reset`: the client's known position is unusable (different generation,
 *   revision ahead of the owner, or malformed). The body replaces the view and
 *   the client must discard every per-key revision and tombstone it retained.
 * - `deleted`: the requested *target* (for per-target views such as one
 *   environment's file list) no longer exists. The client drops the view and
 *   must not resurrect it from buffered updates at or below `revision`.
 *
 * `revision` always identifies the state the owner actually captured for this
 * answer, never a revision read after the body was built.
 */
export type ViewSnapshotOutcome<T> =
  | { status: "unchanged"; generation: ViewGeneration; revision: number }
  | { status: "snapshot"; generation: ViewGeneration; revision: number; snapshot: T }
  | {
      status: "reset";
      generation: ViewGeneration;
      revision: number;
      snapshot: T;
      reason: ViewResetReason;
    }
  | { status: "deleted"; generation: ViewGeneration; revision: number };

export type ViewResetReason = "generation" | "ahead" | "invalid-request";

const RESET_REASONS: ReadonlySet<string> = new Set(["generation", "ahead", "invalid-request"]);

/**
 * Decides the outcome for a conditional read. Pure, so every owner applies the
 * same rules. `capture` is called at most once and only when a body is needed;
 * `current` must be the stamp read atomically with that body.
 */
export function resolveViewSnapshotOutcome<T>(
  request: ParsedViewSnapshotRequest,
  current: ViewRevisionStamp,
  capture: () => T,
): ViewSnapshotOutcome<T> {
  const base = { generation: current.generation, revision: current.revision };
  if (request.kind === "invalid") {
    return { status: "reset", ...base, snapshot: capture(), reason: "invalid-request" };
  }
  if (request.kind === "absent") return { status: "snapshot", ...base, snapshot: capture() };
  const { known } = request;
  if (known.generation !== current.generation) {
    return { status: "reset", ...base, snapshot: capture(), reason: "generation" };
  }
  if (known.revision > current.revision) {
    return { status: "reset", ...base, snapshot: capture(), reason: "ahead" };
  }
  if (known.revision === current.revision) return { status: "unchanged", ...base };
  return { status: "snapshot", ...base, snapshot: capture() };
}

/** Validates a conditional-read answer, including its body, before use. */
export function isViewSnapshotOutcome<T>(
  value: unknown,
  isSnapshot: (snapshot: unknown) => snapshot is T,
): value is ViewSnapshotOutcome<T> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (!isViewGeneration(candidate.generation) || !isViewSnapshotRevision(candidate.revision)) {
    return false;
  }
  switch (candidate.status) {
    case "unchanged":
    case "deleted":
      return candidate.snapshot === undefined;
    case "snapshot":
      return isSnapshot(candidate.snapshot);
    case "reset":
      return (
        typeof candidate.reason === "string" &&
        RESET_REASONS.has(candidate.reason) &&
        isSnapshot(candidate.snapshot)
      );
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Capability fallback
// ---------------------------------------------------------------------------

/**
 * What a peer supports for one view.
 *
 * - `revisioned`: stamped snapshots/events and conditional reads.
 * - `legacy`: unstamped snapshots and events. Keep conservative reconnect
 *   hydration (and any existing polling) for this peer.
 * - `unsupported`: the snapshot command itself is unknown. Do not retry it on a
 *   timer; wait for a reconnect, which may reach a different peer.
 *
 * Arbitrary network or authentication failures are *not* evidence of either
 * fallback; they are ordinary retryable failures.
 */
export type ViewSyncCapability = "revisioned" | "legacy" | "unsupported";

/**
 * Classified response to a snapshot command, whichever form the peer used.
 * Domain adapters build this from their own validators so an invalid body is
 * never applied.
 */
export type ClassifiedViewSnapshot<T> =
  | { kind: "outcome"; outcome: ViewSnapshotOutcome<T> }
  | { kind: "stamped"; stamp: ViewRevisionStamp; snapshot: T }
  | { kind: "legacy"; snapshot: T }
  | { kind: "invalid" };

/**
 * Classifies a snapshot response. A conditional answer is recognised by its
 * `status`; otherwise the value must be a domain snapshot whose optional stamp
 * decides between revisioned and legacy.
 */
export function classifyViewSnapshotResponse<T>(
  value: unknown,
  isSnapshot: (snapshot: unknown) => snapshot is T,
): ClassifiedViewSnapshot<T> {
  if (typeof value === "object" && value !== null && "status" in value) {
    return isViewSnapshotOutcome(value, isSnapshot)
      ? { kind: "outcome", outcome: value }
      : { kind: "invalid" };
  }
  if (!isSnapshot(value)) return { kind: "invalid" };
  const stamp = readViewRevisionStamp(value, "snapshot");
  if (stamp === "invalid") return { kind: "invalid" };
  return stamp ? { kind: "stamped", stamp, snapshot: value } : { kind: "legacy", snapshot: value };
}

/**
 * Whether an error is the backend's "unknown command" answer for `command`.
 * This is the only error that selects the `unsupported` capability.
 */
export function isUnknownViewCommandError(error: unknown, command: string): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return message.includes(`Unknown backend command: ${command}`);
}
