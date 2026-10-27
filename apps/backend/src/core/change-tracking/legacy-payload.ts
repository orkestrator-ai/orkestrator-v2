/**
 * Backend compatibility adapter for legacy transcript tool payloads.
 *
 * Rows recorded before canonical evidence existed carry only the transcript
 * `toolDiff` (`filePath`, `before`, `after`, `diff`). Clients must not count
 * those themselves, so this measures them here under CountPolicyV1 and
 * returns a labelled, non-persisted payload summary with backend hunks.
 *
 * Provider-name knowledge is confined to this adapter: a write-like tool's
 * empty `before` is the old bridges' placeholder for "no prior state", so it
 * is read as unknown, never as an empty file.
 */

import type { ProviderEvidence } from "@orkestrator/protocol/change-evidence";
import type { LineCount } from "@orkestrator/protocol/change-measurements";
import type { ChangeDiffFileBody } from "@orkestrator/protocol/change-resources";
import { measureEvidence } from "@orkestrator/protocol/node/change-tracking/evidence-measure";

const MAX_SIDE_BYTES = 8 * 1024 * 1024;
const WRITE_LIKE = new Set(["write", "create_file"]);

export interface LegacyPayloadInput {
  toolName?: string;
  filePath?: string;
  before?: string;
  after?: string;
  diff?: string;
  /** Counts the old transcript recorded without a body (provider-reported). */
  additions?: number;
  deletions?: number;
}

export interface LegacyPayloadSummary {
  provenanceLabelKey: "changes.provenance.legacy-payload";
  additions: LineCount;
  deletions: LineCount;
  changedFiles: number | null;
  contentLines: number | null;
  reasonKeys: string[];
  files: ChangeDiffFileBody[];
}

export function measureLegacyPayload(
  input: LegacyPayloadInput,
  options: { withHunks?: boolean } = {},
): LegacyPayloadSummary | null {
  const bodies = new Map<string, Uint8Array>();
  const ref = (name: string, text: string) => {
    const bytes = new TextEncoder().encode(text);
    const complete = bytes.length <= MAX_SIDE_BYTES;
    const id = `legacy:${name}`;
    bodies.set(id, complete ? bytes : bytes.subarray(0, MAX_SIDE_BYTES));
    return {
      id,
      state: "available" as const,
      retainedBytes: Math.min(bytes.length, MAX_SIDE_BYTES),
      complete,
    };
  };
  const path = input.filePath || "unknown";
  let evidence: ProviderEvidence | null = null;
  if (typeof input.diff === "string" && input.diff.length > 0) {
    evidence = {
      kind: "patch",
      path,
      body: ref("diff", input.diff),
      format: "git_unified",
      effectClaim: "unknown",
    };
  } else if (input.before !== undefined || input.after !== undefined) {
    const writeLike = WRITE_LIKE.has((input.toolName ?? "").toLowerCase());
    const before =
      input.before === undefined || (writeLike && input.before === "")
        ? ({ state: "unknown", reason: "legacy-before-not-recorded" } as const)
        : ({ state: "present", body: ref("before", input.before) } as const);
    const after =
      input.after === undefined
        ? ({ state: "unknown", reason: "legacy-after-not-recorded" } as const)
        : ({ state: "present", body: ref("after", input.after) } as const);
    evidence = {
      kind: "replacement",
      path,
      before,
      after,
      extent: writeLike ? "whole-file" : "unknown",
      origin: "input",
      effectClaim: "unknown",
    };
  }
  if (
    !evidence &&
    (Number.isSafeInteger(input.additions) || Number.isSafeInteger(input.deletions))
  ) {
    const count = (value: number | undefined) =>
      Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
    evidence = {
      kind: "reported-counts",
      path,
      additions: count(input.additions),
      deletions: count(input.deletions),
      scope: "file",
      effectClaim: "unknown",
    };
  }
  if (!evidence) return null;
  let measured = measureEvidence(evidence, (id) => bodies.get(id) ?? null, {
    withHunks: options.withHunks ?? true,
  });
  // A recorded diff that is not a unified patch carries no counts; fall back
  // to the counts the transcript recorded alongside it, labelled as such.
  if (
    evidence.kind === "patch" &&
    measured.files.length === 0 &&
    (Number.isSafeInteger(input.additions) || Number.isSafeInteger(input.deletions))
  ) {
    const count = (value: number | undefined) =>
      Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
    measured = measureEvidence(
      {
        kind: "reported-counts",
        path,
        additions: count(input.additions),
        deletions: count(input.deletions),
        scope: "file",
        effectClaim: "unknown",
      },
      () => null,
    );
  }
  return {
    provenanceLabelKey: "changes.provenance.legacy-payload",
    additions: measured.additions,
    deletions: measured.deletions,
    changedFiles: measured.changedFiles,
    contentLines: measured.contentLines,
    reasonKeys: [
      "changes.reason.legacy-payload",
      ...measured.reasons.map((reason) => `changes.reason.${reason}`),
    ],
    files: measured.files.map((file) => ({
      pathId: file.path ?? path,
      oldPathDisplay: file.previousPath ?? (file.status === "added" ? null : file.path),
      newPathDisplay: file.status === "deleted" ? null : file.path,
      status: file.status,
      fileKind: file.fileKind,
      bodyAvailability: "available",
      reasonKey: file.reasons[0] ? `changes.reason.${file.reasons[0]}` : null,
      hunks: file.hunks ?? [],
      truncated: file.bodyTruncated,
    })),
  };
}

/**
 * Process-wide on purpose: a bounded memo of a pure function of its content
 * key, so every backend would compute the same entry.
 */
const compatibilityCache = new Map<string, { additions?: number; deletions?: number }>();
const COMPATIBILITY_CACHE_MAX = 2_048;

/**
 * Backend-generated counts for the legacy `toolDiff` shape older clients
 * read (coexistence, guide §15.1). The old bridges' whole-side totals are
 * replaced with CountPolicyV1 counts; a count the old shape cannot express
 * as exact (unknown, partial) is omitted rather than shown as a number.
 * Memoized by the caller's content key (the deferred detail reference).
 */
export function legacyCompatibilityCounts(
  key: string,
  input: LegacyPayloadInput,
): { additions?: number; deletions?: number } {
  const cached = compatibilityCache.get(key);
  if (cached) return cached;
  const summary = measureLegacyPayload(input, { withHunks: false });
  const exact = (count: LineCount | undefined) =>
    count && count.quality === "complete" && count.value !== null ? count.value : undefined;
  const result: { additions?: number; deletions?: number } = {};
  const additions = exact(summary?.additions);
  const deletions = exact(summary?.deletions);
  if (additions !== undefined) result.additions = additions;
  if (deletions !== undefined) result.deletions = deletions;
  compatibilityCache.set(key, result);
  if (compatibilityCache.size > COMPATIBILITY_CACHE_MAX) {
    const oldest = compatibilityCache.keys().next().value;
    if (oldest !== undefined) compatibilityCache.delete(oldest);
  }
  return result;
}
