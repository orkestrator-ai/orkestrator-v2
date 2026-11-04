import { CheckCircle2, CircleDashed, MinusCircle, XCircle, type LucideIcon } from "lucide-react";
import {
  hasKeyInformation,
  type BuildPipelineKeyInformation,
  type KeyInformationAuthor,
  type KeyInformationIssueStatus,
  type KeyInformationSection,
  type KeyInformationTestResult,
} from "@orkestrator/protocol/build-pipeline-key-information";

/**
 * Labels and colours shared by the two presentations of a pipeline's key
 * information: the header's floating panel and the full `key-information` tab.
 */

export const KEY_INFORMATION_AUTHOR_LABELS: Record<KeyInformationAuthor, string> = {
  build: "Build",
  fix: "Rework",
  review: "Review",
  address: "Address Findings",
  verify: "Verify",
  pr: "Ship",
  "resolve-conflicts": "Conflict resolution",
  system: "the pipeline",
};

export const KEY_INFORMATION_TEST_RESULT: Record<
  KeyInformationTestResult,
  { label: string; icon: LucideIcon; className: string }
> = {
  passed: { label: "Passed", icon: CheckCircle2, className: "text-emerald-500" },
  failed: { label: "Failed", icon: XCircle, className: "text-failure" },
  skipped: { label: "Skipped", icon: MinusCircle, className: "text-muted-foreground" },
  "not-run": { label: "Not run", icon: CircleDashed, className: "text-muted-foreground" },
};

export const KEY_INFORMATION_ISSUE_STATUS: Record<
  KeyInformationIssueStatus,
  { label: string; className: string }
> = {
  open: { label: "Open", className: "border-amber-500/30 text-amber-300/90" },
  resolved: { label: "Resolved", className: "border-emerald-500/30 text-emerald-400" },
  "partially-resolved": {
    label: "Partially resolved",
    className: "border-amber-500/30 text-amber-300/90",
  },
  deferred: { label: "Deferred", className: "border-border text-muted-foreground" },
  "wont-fix": { label: "Won't fix", className: "border-border text-muted-foreground" },
};

export const KEY_INFORMATION_SECTION_LABELS: Record<KeyInformationSection, string> = {
  framing: "framing",
  statement: "statement",
  context: "context",
  solution: "solution",
  workDone: "work done",
  decisions: "decisions",
  notDone: "not done",
  tests: "tests",
  issues: "review issues",
  verification: "verification",
};

/** "Updated <when> by <stage> · round <n>", or a placeholder before any update. */
export function keyInformationUpdatedLine(info: BuildPipelineKeyInformation | undefined): string {
  if (!info || !hasKeyInformation(info)) return "Kept up to date by the pipeline's stages.";
  const last = info.updates.at(-1);
  const at = new Date(info.updatedAt).toLocaleString();
  return last
    ? `Updated ${at} by ${KEY_INFORMATION_AUTHOR_LABELS[last.author]} · round ${last.round + 1}`
    : `Updated ${at}`;
}
