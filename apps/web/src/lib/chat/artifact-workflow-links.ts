/**
 * Navigation for workflow-snapshot node links.
 *
 * A link's `targetRef` is an opaque, scoped backend reference. The renderer
 * only recognizes the forms below, each of which maps onto an existing
 * viewer for the exact captured run (never "the latest agent with a similar
 * name"). Anything else stays visible but disabled with an honest label; a
 * reference never becomes a URL, a path or an action.
 *
 *   multi-review:<workflowId>                      the Multi Review workflow tab
 *   multi-review:<workflowId>:reviewer:<reviewerId> that reviewer's transcript
 */

export type WorkflowLinkTarget = { kind: "multi-review"; workflowId: string; reviewerId?: string };

const SEGMENT = /^[A-Za-z0-9._-]{1,100}$/;

export function parseWorkflowTargetRef(ref: string): WorkflowLinkTarget | null {
  if (typeof ref !== "string" || ref.length === 0 || ref.length > 128) return null;
  const parts = ref.split(":");
  if (!parts.every((part) => SEGMENT.test(part))) return null;
  if (parts[0] === "multi-review") {
    if (parts.length === 2) return { kind: "multi-review", workflowId: parts[1]! };
    if (parts.length === 4 && parts[2] === "reviewer") {
      return { kind: "multi-review", workflowId: parts[1]!, reviewerId: parts[3]! };
    }
    return null;
  }
  return null;
}

export type CreateWorkflowTab = (
  type: "multi-review",
  options: {
    multiReviewId?: string;
    multiReviewReviewerId?: string;
    displayTitle?: string;
  },
) => boolean;

/** Open the existing viewer for a target. Returns false when it could not be shown. */
export function openWorkflowLinkTarget(
  target: WorkflowLinkTarget,
  createTab: CreateWorkflowTab,
  displayTitle: string,
): boolean {
  return createTab("multi-review", {
    multiReviewId: target.workflowId,
    ...(target.reviewerId ? { multiReviewReviewerId: target.reviewerId } : {}),
    displayTitle,
  });
}
