import type { LineCount } from "@orkestrator/protocol/change-measurements";
import type { ChangeProjection } from "@orkestrator/protocol/change-resources";

/**
 * Localized text for backend label, provenance and reason keys, plus number
 * formatting. Presentation only: which key applies, whether a count is
 * partial and whether a badge shows are backend decisions.
 */

const LABELS: Record<string, string> = {
  "changes.scope.environment-net": "Environment changes",
  "changes.scope.uncommitted-net": "Uncommitted changes",
  "changes.scope.staged": "Staged changes",
  "changes.scope.unstaged": "Unstaged changes",
  "changes.scope.turn-net": "This turn's changes",
  "changes.scope.provider-turn-diff": "Provider-reported turn changes",
  "changes.scope.thread-net": "Thread changes",
  "changes.scope.tool-effect": "Tool change",
  "changes.scope.observation-window": "Workspace changes observed during this tool",
  "changes.scope.tool-payload": "Proposed / reported content",
  "changes.scope.operation-volume": "Recorded edit activity",
  "changes.scope.commit": "Commit changes",
  "changes.scope.pull-request": "Pull request changes",
  "changes.provenance.observed-fresh": "Measured in the workspace around this tool",
  "changes.provenance.observed-after-start": "Observed in the workspace after the tool started",
  "changes.provenance.observed": "Observed in the workspace",
  "changes.provenance.provider-reported": "Reported by the provider",
  "changes.provenance.proposal": "Proposed (not verified as applied)",
  "changes.provenance.content-only": "Content written; prior file state unknown",
  "changes.provenance.legacy": "Legacy summary",
  "changes.provenance.legacy-payload": "Recorded tool input (measured by the backend)",
  "changes.provenance.unknown": "Unknown provenance",
};

const REASONS: Record<string, string> = {
  "changes.reason.known-overlap": "Other writers overlapped this interval",
  "changes.reason.changed-during-capture": "Files changed while they were being read",
  "changes.reason.provisional": "Still in progress",
  "changes.reason.interrupted": "Ended before every writer settled",
  "changes.reason.failed-with-effect": "The tool failed after changing files",
  "changes.reason.stale": "Last refresh failed; showing the previous result",
  "changes.reason.start-unavailable": "The turn's starting state could not be captured",
  "changes.reason.end-unavailable": "The ending state could not be captured",
  "changes.reason.end-captured-later":
    "The ending state took too long to capture, so it was captured after the turn ended",
  "changes.reason.baseline-unavailable": "The thread's starting state is unknown",
  "changes.reason.baseline-mutable-ref": "Compared against a branch name, not a fixed commit",
  "changes.reason.untracked-scan-capped": "Too many untracked files to count them all",
  "changes.reason.ambiguous-index-membership": "A file was removed from Git but is still on disk",
  "changes.reason.count-omitted": "Some files were too large or unreadable to count",
  "changes.reason.file-rows-capped": "Too many changed files to list; the totals count them all",
  "changes.reason.file-list-truncated": "The provider listed only some of the changed files",
  "changes.reason.fragment-extent": "Counts the edited fragment, not the whole file",
  "changes.reason.provider-counts-disagree": "The provider's own counts disagree with its diff",
  "changes.reason.legacy-summary-only": "Recorded before full history was kept",
  "changes.reason.legacy-payload": "Recorded before change tracking; measured from the tool input",
  "changes.reason.history-replay": "Rebuilt from saved history",
  "changes.reason.resource-deleted": "No longer available",
  "changes.reason.history-expired": "Past the retention window, so its details were removed",
  "changes.reason.scan-failed": "Could not read the workspace",
  "changes.reason.runtime-stopped": "The environment is stopped",
  "changes.reason.capture-timeout": "Capturing the workspace took too long",
  "changes.reason.executor-private-endpoints":
    "Measured by the bridge; the file contents were not retained",
  "changes.staging.unsupported-identity":
    "Hunks can be staged only from a current workspace diff (unstaged, uncommitted or environment changes) and unstaged from the staged diff",
  "changes.staging.side-unknown": "One side of this diff could not be read, so it cannot be staged",
  "changes.staging.whole-file":
    "New, deleted and renamed files are staged as a whole file, not by hunk",
  "changes.staging.path-encoding": "This file's path cannot be staged by hunk",
  "changes.staging.binary": "Binary files cannot be staged by hunk",
  "changes.staging.too-large": "This file is too large to stage by hunk",
  "changes.staging.truncated": "This change is cut off in the view, so it cannot be staged by hunk",
  "changes.staging.hunk-changed":
    "This change no longer matches the diff you reviewed. Reload the diff and review it again.",
  "changes.staging.worktree-changed":
    "The file changed after this diff was loaded. Reload the diff and review it again.",
  "changes.staging.head-changed":
    "The committed version of this file changed. Reload the diff and review it again.",
  "changes.staging.index-changed":
    "The staged version of this file changed after this diff was loaded. Reload the diff and review it again.",
  "changes.staging.index-mismatch":
    "This file already has staged changes, so this diff is not against the index. Switch to Unstaged to stage from the current index.",
  "changes.staging.index-conflict": "This file has unresolved merge conflicts in the index",
  "changes.staging.not-in-index": "This file is not tracked by Git",
  "changes.staging.special-file": "Symlinks and submodules cannot be staged by hunk",
  "changes.staging.git-conversion":
    "Git converts this file when staging it (line endings or a filter), so it cannot be staged by hunk",
  "changes.staging.git-failed":
    "Git could not update the index (another Git command may be running). Try again.",
  "changes.error.owner-replaced":
    "The workspace was replaced after this diff was loaded. Reload the diff.",
  "changes.error.runtime-unavailable": "The environment is not running",
};

export function changeLabel(key: string, args: Record<string, string | number> = {}): string {
  const template = LABELS[key] ?? key.replace(/^changes\.[a-z-]+\./, "").replaceAll("-", " ");
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(args[name] ?? ""));
}

export function changeReason(key: string): string {
  return (
    REASONS[key] ??
    key.replace(/^changes\.(reason|body|error|restore|staging)\./, "").replaceAll("-", " ")
  );
}

const numberFormat = new Intl.NumberFormat();

/** "+12", "~+12" (partial/estimated), "≥+12" (lower bound), "+?" unknown, "" not applicable. */
export function formatLineCount(sign: "+" | "-", count: LineCount): string {
  if (count.quality === "not-applicable") return "";
  if (count.value === null) return `${sign}?`;
  const value = `${sign}${numberFormat.format(count.value)}`;
  if (count.bound === "lower") return `≥${value}`;
  if (count.bound === "upper") return `≤${value}`;
  return count.quality === "complete" ? value : `~${value}`;
}

export function formatFileCount(count: number | null): string {
  if (count === null) return "? files";
  return `${numberFormat.format(count)} file${count === 1 ? "" : "s"}`;
}

/** Tooltip text: scope, provenance and every reason the backend gave. */
export function projectionTitle(projection: ChangeProjection): string {
  const lines = [
    changeLabel(projection.labelKey, projection.labelArgs),
    changeLabel(projection.provenanceLabelKey),
  ];
  for (const reason of projection.reasonKeys) lines.push(changeReason(reason));
  return lines.join("\n");
}
