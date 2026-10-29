/**
 * The Build Pipeline's Kanban ticket lifecycle: which column a ticket moves
 * to and which comment it gets at each point of a build. The pipeline
 * (`build-pipeline-service-supervisor.ts`, `-recovery.ts`) and the graph
 * `update-ticket` system node (`graph-system-ticket.ts`, its `lifecycle`
 * parameter) both read this one table, so a graph run updates a ticket
 * exactly as today's pipeline does.
 */
import type { GraphTicketLifecycleEvent } from "@orkestrator/protocol/graphs/system-actions";

export interface BuildPipelineKanbanUpdate {
  status?: "backlog" | "in-progress" | "review";
  comment?: string;
  prUrl?: string;
  prState?: "open" | "merged" | "closed";
}

export const BUILD_PIPELINE_BUILD_STARTED_COMMENT = "🔨 Build started";
export const BUILD_PIPELINE_VALIDATION_COMPLETE_COMMENT = "✅ Validation complete";

export function buildPipelinePrRaisedComment(url: string): string {
  return `🔗 PR raised: ${url}`;
}

/**
 * The update for one lifecycle event. `pr-raised` links the pull request
 * (`pr` is required for it); the other events ignore `pr`.
 */
export function buildPipelineKanbanUpdate(
  event: GraphTicketLifecycleEvent,
  pr?: { url: string; state?: "open" | "merged" | "closed" },
): BuildPipelineKanbanUpdate {
  switch (event) {
    case "build-started":
      return { status: "in-progress", comment: BUILD_PIPELINE_BUILD_STARTED_COMMENT };
    case "validation-complete":
      return { comment: BUILD_PIPELINE_VALIDATION_COMPLETE_COMMENT };
    case "pr-raised":
      if (!pr) throw new Error("A pr-raised ticket update needs the pull request");
      return {
        status: "review",
        prUrl: pr.url,
        prState: pr.state ?? "open",
        comment: buildPipelinePrRaisedComment(pr.url),
      };
    case "complete":
      return { status: "review" };
    case "failed":
      return { status: "backlog" };
  }
}
