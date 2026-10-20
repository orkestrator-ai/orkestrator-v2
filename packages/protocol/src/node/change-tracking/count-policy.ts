/**
 * Versioned counting and representation policies (CountPolicyV1).
 *
 * Every measurement names the policies that produced it. A policy change
 * applies to future work only; recalculating retained endpoints under a new
 * policy creates a superseding measurement with the new identity, so an
 * upgrade can never silently rewrite historical counts.
 *
 * See `docs/architecture/change-tracking.md#count-policy`.
 */

/**
 * raw-lines-v1: split on LF, each token keeps its terminator. A final
 * unterminated line counts; a terminal LF adds no phantom line. CR is part of
 * the token, so LF→CRLF on one line is one removal plus one addition. Bare CR
 * is never a separator. Deterministic Myers edit script, fixed tie-breaking,
 * no whitespace suppression, exact-content rename pairing only.
 */
export const RAW_LINES_POLICY_ID = "raw-lines-v1";

/** Myers implementation revision bundled with raw-lines-v1. */
export const RAW_LINES_ALGORITHM_ID = "raw-lines-v1/myers-bounded-1";

/** Hunk-aware unified patch parser used for both counts and bodies. */
export const PATCH_PARSER_ALGORITHM_ID = "unified-patch-v1";

/** Provider-reported numeric totals taken as declared. */
export const REPORTED_COUNTS_ALGORITHM_ID = "reported-counts-v1";

/**
 * Git-representation comparisons for environment and source-control scopes:
 * immutable resolved refs, `--no-ext-diff --no-textconv`, `-M` rename profile
 * pinned by the installed Git version.
 */
export function gitNumstatAlgorithmId(gitVersion: string): string {
  return `git-numstat-v1/git-${gitVersion.replace(/[^0-9A-Za-z.]/g, "") || "unknown"}/M50`;
}

/** Captured raw filesystem bytes and modes (thread, turn, tool scopes). */
export const RAW_BYTES_REPRESENTATION_ID = "raw-bytes-v1";

/** Repository Git representation (index, HEAD, refs) with existing conversions. */
export const GIT_REPRESENTATION_ID = "git-representation-v1";

/** Provider payload text as supplied (patches, replacement fragments). */
export const PROVIDER_PAYLOAD_REPRESENTATION_ID = "provider-payload-v1";

/** Records imported from the legacy command journals. */
export const LEGACY_REPRESENTATION_ID = "legacy-journal-v1";
export const LEGACY_ALGORITHM_ID = "legacy-journal-v1";

/** Body renderer for backend-prepared hunks. */
export const HUNK_RENDERER_POLICY_ID = "hunks-v1";

/** Evidence selection policy (see evidence-selection.ts). */
export const MEASUREMENT_SELECTION_POLICY_ID = "measurement-selection-v1";
