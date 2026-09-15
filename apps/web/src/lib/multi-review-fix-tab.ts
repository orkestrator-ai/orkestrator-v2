import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";

/** True when this pane tab is the Fix session owned by the given Multi Review. */
export function isMultiReviewFixTabId(
  tabId: string,
  workflowId: string,
  fixTabId?: string,
): boolean {
  if (fixTabId === tabId) return true;
  const prefix = `multi-review-fix:${workflowId}`;
  return tabId === prefix || tabId.startsWith(`${prefix}:`);
}

/**
 * The consolidated report a Fix tab should pin above its opening prompt.
 *
 * Lookup is presentation-only: the provider already received the findings in
 * the address or custom-fix prompt. The transcript shows the durable report
 * the Multi Review tab already owns so the first user bubble is not a wall of
 * hidden JSON.
 */
export function findMultiReviewFixReport(
  workflows: Iterable<MultiReviewWorkflow>,
  tabId: string,
  environmentId: string,
): StructuredReviewReport | undefined {
  if (!tabId.startsWith("multi-review-fix:")) return undefined;
  for (const workflow of workflows) {
    if (workflow.environmentId !== environmentId) continue;
    if (!isMultiReviewFixTabId(tabId, workflow.id, workflow.fixTabId)) continue;
    return workflow.consolidatedReport;
  }
  return undefined;
}
