import { KeyedSingleFlight } from "./keyed-single-flight.js";
import type { KanbanTask } from "./storage-shared.js";

/**
 * In-flight feature-build work of one backend: ticket resolution per
 * `projectId:requestId`, so overlapping retries return the same ticket, and
 * the background title refinement per ticket. Owned by `BackendRuntime` as
 * `featureBuilds` and reached through `context.runtime` at call time.
 */
export class FeatureBuildTasks {
  private readonly taskResolutions = new KeyedSingleFlight<KanbanTask>();
  private readonly titleRefinements = new KeyedSingleFlight<void>();

  /** Joins the request's in-flight ticket resolution, or starts one. */
  resolveTask(requestKey: string, resolve: () => Promise<KanbanTask>): Promise<KanbanTask> {
    return this.taskResolutions.run(requestKey, resolve);
  }

  /** Starts the ticket's title refinement unless one is already running. */
  refineTitle(taskId: string, refine: () => Promise<void>): void {
    if (this.titleRefinements.has(taskId)) return;
    void this.titleRefinements.run(taskId, refine);
  }

  /** Wait for the background title refinements this backend scheduled. */
  titleRefinementsSettled(): Promise<void> {
    return this.titleRefinements.settled();
  }
}
