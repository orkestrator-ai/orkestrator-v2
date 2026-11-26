// The worktrees domain's public surface: the only module other backend code
// imports. Re-export by name (never `export *`) so the surface stays
// reviewable.
//
// `removal-reads.ts` is a named exception in `.oxlintrc.json`, not part of this
// surface: it imports `change-tracking/index.js`, and change tracking reaches
// `commands/files.ts` and `containers/git-fetch.ts`, which import this file, so
// re-exporting `WorktreeRemovalReads` here would close a runtime import cycle.
// `diff-stats-service.ts` imports it directly.
export {
  AdhocWorktreeReads,
  worktreeTargetKey,
  type AdhocTreeCacheLimits,
  type FileListScanRequest,
  type FileListScanResult,
  type TreeWalkRequest,
  type WorktreeLookup,
} from "./adhoc-reads.js";
export { resolveWorktreeGitPaths } from "./git-paths.js";
export {
  configuredWorktreeLocations,
  getWorktreeBaseDir,
  getWorktreeLocations,
  resolveEnvironmentWorktreeRoot,
  updateWorktreeLocations,
  validateWorktreeLocation,
} from "./locations.js";
export { responseDigest, semanticFileListDigest, treeMembershipDigest } from "./snapshot-digest.js";
export {
  WorktreeTreeSnapshots,
  type TreeSnapshotLimits,
  type TreeTarget,
} from "./tree-snapshots.js";
export {
  startWorktreeWatcher,
  type WorktreeChangeHint,
  type WorktreeWatcher,
  type WorktreeWatcherOptions,
} from "./watcher.js";
