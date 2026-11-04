import {
  MULTI_REVIEW_ADDRESS_FINDINGS_TAB_TITLE,
  MULTI_REVIEW_FORMER_FIX_TAB_TITLE,
  MULTI_REVIEW_LEGACY_FIX_TAB_TITLE,
} from "@orkestrator/protocol/multi-review";
import type { TabInfo } from "@/types/paneLayout";

export type WorkflowTabTitle =
  "Review" | typeof MULTI_REVIEW_ADDRESS_FINDINGS_TAB_TITLE | "PR" | "Resolve";

/** Presentation-only normalization for current and restored workflow tabs. */
export function getWorkflowTabTitle(tab: TabInfo): WorkflowTabTitle | undefined {
  if (tab.isReviewTab) {
    return tab.displayTitle === MULTI_REVIEW_ADDRESS_FINDINGS_TAB_TITLE ||
      tab.displayTitle === MULTI_REVIEW_FORMER_FIX_TAB_TITLE ||
      tab.displayTitle === MULTI_REVIEW_LEGACY_FIX_TAB_TITLE
      ? MULTI_REVIEW_ADDRESS_FINDINGS_TAB_TITLE
      : "Review";
  }
  if (tab.displayTitle === "PR") return "PR";
  if (tab.displayTitle === "Resolve" || tab.displayTitle === "Conflict") {
    return "Resolve";
  }
  return undefined;
}
