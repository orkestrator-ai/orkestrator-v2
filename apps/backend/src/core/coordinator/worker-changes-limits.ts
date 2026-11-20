/** Bounds of `get_worker_changes`; no imports, so the MCP schema and the reader share them. */
export const WORKER_CHANGES_LIMITS = Object.freeze({
  defaultFiles: 100,
  maxFiles: 500,
  /** Rows read from one measurement to apply a `paths` filter or an offset. */
  maxScannedRows: 5_000,
  maxPaths: 50,
  maxPathChars: 512,
  defaultCommits: 50,
  maxCommits: 200,
  defaultFileDiffBytes: 16 * 1024,
  defaultTotalDiffBytes: 64 * 1024,
  maxTotalDiffBytes: 256 * 1024,
  /** Files rendered per call: each one is a live read of the file and its baseline. */
  defaultDiffFiles: 20,
  maxDiffFiles: 50,
  pageRows: 200,
});

/**
 * Which diffs an answer carries: `sinceBase` (the default, and the only one
 * before `diffScope` existed) is base to working tree; `committed` and
 * `uncommitted` split it at `HEAD`; `split` is both, sharing the byte budget.
 */
export const WORKER_DIFF_SCOPES = ["sinceBase", "committed", "uncommitted", "split"] as const;
export type WorkerDiffScope = (typeof WORKER_DIFF_SCOPES)[number];
