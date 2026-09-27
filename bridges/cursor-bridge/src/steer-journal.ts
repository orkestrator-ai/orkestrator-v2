/**
 * The bounded steer journal: admission, update, retention and hydration.
 *
 * A steer journal entry is what makes an exact retry safe. A retried request
 * whose record is still here gets its original answer; one whose record is
 * gone reaches the steer route as a *new* request. So eviction is a replay
 * decision, not just a memory one, and a plain FIFO is wrong: evicting a
 * record that still targets the running turn would let the same instruction
 * be delivered to that turn twice.
 *
 * The rules:
 *
 * - A record is protected while it is still `prepared` or targets the run that
 *   can currently accept steering. Only unprotected records are evicted, oldest
 *   first, so a retry of an evicted record targets a run that is no longer
 *   active and can never be delivered a second time. Its run is fenced (next
 *   rule), so the retry is answered `unknown` rather than as a mismatch or
 *   idle, which a caller could read as "never delivered".
 * - A run whose records were evicted is remembered in a bounded fence. A
 *   request against a fenced run that has no record is answered `unknown`,
 *   never idle, mismatch or rejected: this journal can no longer tell a
 *   forgotten retry of a delivered instruction from a new one.
 * - When a name has to leave that bounded fence, the fence remembers *when*
 *   (`overflowBefore`) rather than just *that*. A dropped run was created no
 *   later than that moment, so only a recovered run created at or before it is
 *   treated as fenced; runs created afterwards are steerable again.
 * - When protected records alone fill the count or byte budget, a new request
 *   is refused before anything is journaled or sent. The running turn carries
 *   on; the user can steer again once it settles.
 *
 * Every mutation goes through this module, live and on restore, so the byte
 * charge cannot drift from what is actually held.
 */
import {
  MAX_STEER_FENCE_RUNS,
  MAX_STEER_ID_BYTES,
  MAX_STEER_JOURNAL,
  MAX_STEER_JOURNAL_BYTES,
} from "./config.js";
import type { NativeAgentRuntimeSteerJournal } from "@orkestrator/protocol/native-agent";
import { isObject, nonBlank, type SessionState, type SteerJournalEntry } from "./state.js";

export interface SteerJournalLimits {
  entries: number;
  bytes: number;
  fenceRuns: number;
}

export const DEFAULT_STEER_JOURNAL_LIMITS: SteerJournalLimits = Object.freeze({
  entries: MAX_STEER_JOURNAL,
  bytes: MAX_STEER_JOURNAL_BYTES,
  fenceRuns: MAX_STEER_FENCE_RUNS,
});

export type SteerRejectionReason =
  | "steer-capacity-exceeded"
  | "steer-history-unavailable"
  | "steer-not-recorded";

export type SteerAdmission =
  | { admitted: true }
  | { admitted: false; reason: Exclude<SteerRejectionReason, "steer-not-recorded"> };

/** A record as the state file stores it: a restart must read `prepared` as unknown. */
function persistedEntry(entry: SteerJournalEntry): SteerJournalEntry {
  return entry.state === "prepared" ? { ...entry, state: "ambiguous" } : entry;
}

/**
 * Encoded size of one record as the state file stores it.
 *
 * Charged on the persisted form, so the live count and the one a restore
 * rebuilds from the file agree byte for byte.
 */
export function steerEntryBytes(entry: SteerJournalEntry): number {
  return Buffer.byteLength(JSON.stringify(persistedEntry(entry)));
}

/**
 * The run a steer can currently reach, if any.
 *
 * Records against it are protected: an exact retry must keep finding its
 * record for as long as that run can still receive the same text again.
 */
function steerableRunId(state: SessionState): string | undefined {
  return state.activeRun?.id;
}

function isProtected(state: SessionState, entry: SteerJournalEntry): boolean {
  return entry.state === "prepared" || entry.expectedRunId === steerableRunId(state);
}

/**
 * Whether this journal has forgotten history for `runId`.
 *
 * A named run is fenced. Beyond the names, an overflowed fence can only judge
 * the run a steer can currently reach: a run this process started was
 * protected for as long as it was steerable and so was never evicted, which
 * leaves a *recovered* run as the only kind that can have been dropped — and
 * only one created at or before the last drop. A recovered run whose creation
 * time the SDK did not report is fenced, conservatively.
 *
 * A run that is neither named nor active is not fenced here. The route answers
 * a request against it as a mismatch or idle, which cannot deliver anything.
 */
export function steerHistoryFenced(state: SessionState, runId: string): boolean {
  const fence = state.steerFence;
  if (!fence) return false;
  if (fence.runs.includes(runId)) return true;
  if (fence.overflowBefore === undefined) return false;
  if (state.activeRun?.id !== runId || state.activeRunRecovered !== true) return false;
  const createdAt = state.activeRunCreatedAt ?? state.activeRun.createdAt;
  return createdAt === undefined || createdAt <= fence.overflowBefore;
}

/**
 * Reserve a slot for a new, distinct request and record it as `prepared`.
 *
 * Synchronous on purpose: the reservation is taken before the caller awaits
 * publication, so two concurrent requests cannot both pass a check for the
 * last slot. Unprotected records are evicted to make room; protected ones
 * never are.
 */
export function admitSteer(
  state: SessionState,
  entry: SteerJournalEntry,
  limits: SteerJournalLimits = DEFAULT_STEER_JOURNAL_LIMITS,
): SteerAdmission {
  if (steerHistoryFenced(state, entry.expectedRunId)) {
    return { admitted: false, reason: "steer-history-unavailable" };
  }
  const bytes = steerEntryBytes(entry);
  if (bytes > limits.bytes) return { admitted: false, reason: "steer-capacity-exceeded" };
  const fits = () =>
    state.steerJournal.size + 1 <= limits.entries &&
    state.steerJournalBytes + bytes <= limits.bytes;
  if (!fits()) {
    const evictable = Array.from(state.steerJournal.values()).filter(
      (candidate) => !isProtected(state, candidate),
    );
    // Check before evicting anything: a refusal must not also have thrown
    // away history it did not need to.
    let releasableCount = 0;
    let releasableBytes = 0;
    for (const candidate of evictable) {
      releasableCount += 1;
      releasableBytes += steerEntryBytes(candidate);
    }
    if (
      state.steerJournal.size - releasableCount + 1 > limits.entries ||
      state.steerJournalBytes - releasableBytes + bytes > limits.bytes
    ) {
      return { admitted: false, reason: "steer-capacity-exceeded" };
    }
    for (const candidate of evictable) {
      if (fits()) break;
      evictSteer(state, candidate, limits);
    }
  }
  setSteerEntry(state, entry);
  // Capacity is available again, so the next saturation is a new transition.
  if (state.steerNoticed?.saturated) state.steerNoticed.saturated = false;
  return { admitted: true };
}

/** Replace a record's outcome, charging only the difference. */
export function setSteerEntry(state: SessionState, entry: SteerJournalEntry): void {
  const previous = state.steerJournal.get(entry.requestId);
  if (previous) state.steerJournalBytes -= steerEntryBytes(previous);
  state.steerJournal.set(entry.requestId, entry);
  state.steerJournalBytes += steerEntryBytes(entry);
}

/**
 * Forget a record that provably never reached the provider.
 *
 * Only for a request refused before delivery — a failed publication, say.
 * Evicting delivered history goes through {@link evictSteer}, which fences.
 */
export function removeSteer(state: SessionState, requestId: string): void {
  const previous = state.steerJournal.get(requestId);
  if (!previous) return;
  state.steerJournal.delete(requestId);
  state.steerJournalBytes -= steerEntryBytes(previous);
}

function evictSteer(
  state: SessionState,
  entry: SteerJournalEntry,
  limits: SteerJournalLimits,
): void {
  removeSteer(state, entry.requestId);
  fenceRun(state, entry.expectedRunId, limits);
}

function fenceRun(state: SessionState, runId: string, limits: SteerJournalLimits): void {
  if (!runId) return;
  const fence = (state.steerFence ??= { runs: [] });
  if (fence.runs.includes(runId)) return;
  fence.runs.push(runId);
  while (fence.runs.length > limits.fenceRuns) {
    fence.runs.shift();
    // The dropped run was created before its records were evicted, which was
    // no later than now.
    markOverflow(fence, Date.now());
  }
}

function markOverflow(fence: NonNullable<SessionState["steerFence"]>, at: number): void {
  fence.overflowBefore = Math.max(fence.overflowBefore ?? 0, at);
}

/**
 * The persisted form: `prepared` becomes `ambiguous`, as a restart must read
 * it. The legacy `overflow` boolean is written beside `overflowBefore` so an
 * older bridge that knows only the boolean still fences conservatively.
 */
export function persistedSteerJournal(state: SessionState): {
  steerJournal: SteerJournalEntry[];
  steerFence?: { runs: string[]; overflowBefore?: number; overflow?: boolean };
} {
  const fence = state.steerFence;
  return {
    steerJournal: Array.from(state.steerJournal.values()).map(persistedEntry),
    ...(fence && (fence.runs.length > 0 || fence.overflowBefore !== undefined)
      ? {
          steerFence: {
            runs: fence.runs.slice(),
            ...(fence.overflowBefore !== undefined
              ? { overflowBefore: fence.overflowBefore, overflow: true }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * Rebuild a session's journal from its persisted form, within the same bounds.
 *
 * A file written before the journal was bounded can hold any number of
 * records. The newest that fit are kept; every run whose records did not fit
 * is fenced, so a forgotten id is never read as a fresh request. A record
 * whose fields are malformed or oversized is dropped the same way — and fences
 * its run when the run id itself is readable.
 */
export function restoreSteerJournal(
  state: SessionState,
  rawEntries: unknown,
  rawFence: unknown,
  limits: SteerJournalLimits = DEFAULT_STEER_JOURNAL_LIMITS,
): void {
  state.steerJournal.clear();
  state.steerJournalBytes = 0;
  state.steerFence = undefined;
  if (isObject(rawFence) && Array.isArray(rawFence.runs)) {
    for (const runId of rawFence.runs.slice(-limits.fenceRuns)) {
      if (readBoundedId(runId)) fenceRun(state, runId as string, limits);
    }
    const overflowBefore = rawFence.overflowBefore;
    if (
      typeof overflowBefore === "number" &&
      Number.isFinite(overflowBefore) &&
      overflowBefore >= 0
    ) {
      markOverflow((state.steerFence ??= { runs: [] }), Math.floor(overflowBefore));
    } else if (rawFence.overflow === true) {
      // Written by a bridge that recorded only that an overflow happened, at
      // some point before this process started. Now bounds it conservatively:
      // every run that could have been dropped was created before this load.
      markOverflow((state.steerFence ??= { runs: [] }), Date.now());
    }
  }
  if (!Array.isArray(rawEntries)) return;

  const kept: SteerJournalEntry[] = [];
  let bytes = 0;
  // Newest first, so the records most likely to be retried are the ones kept.
  for (let index = rawEntries.length - 1; index >= 0; index -= 1) {
    const raw = rawEntries[index];
    const entry = readSteerEntry(raw);
    if (!entry) {
      if (isObject(raw) && readBoundedId(raw.expectedRunId)) {
        fenceRun(state, raw.expectedRunId as string, limits);
      }
      continue;
    }
    if (kept.some((candidate) => candidate.requestId === entry.requestId)) continue;
    const entryBytes = steerEntryBytes(entry);
    if (kept.length + 1 > limits.entries || bytes + entryBytes > limits.bytes) {
      fenceRun(state, entry.expectedRunId, limits);
      continue;
    }
    kept.push(entry);
    bytes += entryBytes;
  }
  for (const entry of kept.reverse()) setSteerEntry(state, entry);
}

function readSteerEntry(value: unknown): SteerJournalEntry | undefined {
  if (!isObject(value)) return undefined;
  const requestId = readBoundedId(value.requestId);
  if (!requestId) return undefined;
  const expectedRunId = typeof value.expectedRunId === "string" ? value.expectedRunId : "";
  if (Buffer.byteLength(expectedRunId) > MAX_STEER_ID_BYTES) return undefined;
  const inputDigest =
    typeof value.inputDigest === "string" && /^[0-9a-f]{64}$/.test(value.inputDigest)
      ? value.inputDigest
      : "";
  const createdAt =
    typeof value.createdAt === "number" && Number.isFinite(value.createdAt) && value.createdAt >= 0
      ? Math.floor(value.createdAt)
      : 0;
  return {
    requestId,
    inputDigest,
    expectedRunId,
    // Only an explicit positive or negative survives a restart. `prepared`
    // was written by a process that died before it knew the outcome.
    state: value.state === "delivered" || value.state === "absent" ? value.state : "ambiguous",
    createdAt,
  };
}

function readBoundedId(value: unknown): string | undefined {
  return nonBlank(value) && Buffer.byteLength(value) <= MAX_STEER_ID_BYTES ? value : undefined;
}

/** The smallest record a new request could add; what "one more" costs at least. */
let minimumEntryBytes: number | undefined;
function smallestEntryBytes(): number {
  return (minimumEntryBytes ??= steerEntryBytes({
    requestId: "x",
    inputDigest: "0".repeat(64),
    expectedRunId: "x",
    state: "absent",
    createdAt: Date.now(),
  }));
}

/**
 * Whether a new distinct steer would be refused as over capacity until the
 * run settles: protected records alone leave no room for even the smallest
 * record.
 */
export function steerJournalSaturated(
  state: SessionState,
  limits: SteerJournalLimits = DEFAULT_STEER_JOURNAL_LIMITS,
): boolean {
  let count = 0;
  let bytes = 0;
  for (const entry of state.steerJournal.values()) {
    if (!isProtected(state, entry)) continue;
    count += 1;
    bytes += steerEntryBytes(entry);
  }
  return count + 1 > limits.entries || bytes + smallestEntryBytes() > limits.bytes;
}

/** Occupancy for the runtime-health summary. Counts and limits only. */
export function steerJournalSummary(
  state: SessionState,
  limits: SteerJournalLimits = DEFAULT_STEER_JOURNAL_LIMITS,
): NativeAgentRuntimeSteerJournal {
  return {
    entries: state.steerJournal.size,
    limitEntries: limits.entries,
    bytes: state.steerJournalBytes,
    limitBytes: limits.bytes,
    fencedRuns: state.steerFence?.runs.length ?? 0,
    saturated: steerJournalSaturated(state, limits),
  };
}

/**
 * Surface a refusal as a runtime-health notice — once per transition, not
 * once per refused request. The notice carries counts and limits only: never
 * a request id, a run id, a digest or the instruction.
 */
export function noteSteerRefusal(
  state: SessionState,
  kind: "saturated" | "fenced",
  runId: string,
  limits: SteerJournalLimits = DEFAULT_STEER_JOURNAL_LIMITS,
): void {
  const noticed = (state.steerNoticed ??= {});
  if (kind === "saturated") {
    if (noticed.saturated) return;
    noticed.saturated = true;
    state.health.recordNotice({
      message:
        "Steering is paused for the running turn: its steer history is full. Send further instructions after the turn finishes.",
      method: "steer-journal",
      severity: "warning",
      detail: `entries ${state.steerJournal.size}/${limits.entries}, bytes ${state.steerJournalBytes}/${limits.bytes}`,
    });
  } else {
    if (noticed.fencedRunId === runId) return;
    noticed.fencedRunId = runId;
    state.health.recordNotice({
      message:
        "Steering is unavailable for this run: part of its steer history was evicted, so a retry cannot be told apart from a new instruction.",
      method: "steer-journal",
      severity: "warning",
      detail: `fenced runs ${state.steerFence?.runs.length ?? 0}/${limits.fenceRuns}`,
    });
  }
  state.revision += 1;
}
