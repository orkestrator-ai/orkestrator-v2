import { coordinatorApi } from "@/lib/node-scope/domains/coordinator";
/**
 * One-request launches: the renderer states what the user chose and the
 * backend fills the saved defaults, owns every step and compensates failures.
 *
 * Each has an older-backend answer in the caller, chosen with
 * `incompatibility(error, command)` (`@orkestrator/protocol/contract/errors`) and listed in
 * `docs/architecture/version-compatibility.md`.
 */
import type { BuildPipeline as BackendBuildPipeline } from "@orkestrator/protocol/build-pipeline";
import type { LaunchBuildPipelineInput } from "@orkestrator/protocol/build-pipeline-defaults";
import type {
  StartFeaturePlanBuildInput,
  StartFeaturePlanBuildResult,
} from "@orkestrator/protocol/feature-build";
import type {
  LaunchMultiReviewActionInput,
  MultiReviewActionResult,
  MultiReviewModelSelection,
} from "@orkestrator/protocol/multi-review";
import { pipelines } from "@/lib/node-scope/domains/pipelines";
import { commandBackendClient, type BackendClient } from "./client";

/** The rows and automation a plain Multi Review click runs, as the backend resolved them. */
export interface MultiReviewLaunchDefaultRows {
  reviewers: MultiReviewModelSelection[];
  reviewModel: MultiReviewModelSelection;
  fixModel: MultiReviewModelSelection;
  autoFix: boolean;
  autoPr: boolean;
}

/**
 * This file's commands on `client`'s node (plan item 3002). A scoped store or
 * service passes its own node's client; the named exports below are this
 * over the window's command scope.
 */
export function createLaunchesApi(client: BackendClient) {
  /** The Build button: the ticket and only the choices the user made. */
  async function launchBuildPipeline(
    input: LaunchBuildPipelineInput,
  ): Promise<BackendBuildPipeline> {
    return pipelines(client).launch_build_pipeline({ ...input });
  }

  /** The Features view's Build: the backend claims, creates the ticket and starts. */
  async function startFeaturePlanBuild(
    input: StartFeaturePlanBuildInput,
  ): Promise<StartFeaturePlanBuildResult> {
    return pipelines(client).start_feature_plan_build({ ...input });
  }

  /**
   * The Multi Review button. `input.requestId` also reserves the workflow id, so
   * a retry after a lost answer reattaches instead of starting a second review.
   */
  async function launchMultiReview(
    input: LaunchMultiReviewActionInput,
  ): Promise<MultiReviewActionResult> {
    return coordinatorApi(client).launch_multi_review({
      input: { ...input },
      reservedId: input.requestId,
    }) as Promise<MultiReviewActionResult>;
  }

  /**
   * What a plain Multi Review click on `environmentId` runs, resolved by that
   * environment's node from its saved settings and its own model catalogue.
   */
  async function getMultiReviewLaunchDefaults(
    environmentId: string,
  ): Promise<MultiReviewLaunchDefaultRows> {
    return coordinatorApi(client).get_multi_review_launch_defaults({
      environmentId,
    }) as Promise<MultiReviewLaunchDefaultRows>;
  }

  return {
    launchBuildPipeline,
    startFeaturePlanBuild,
    launchMultiReview,
    getMultiReviewLaunchDefaults,
  };
}

export type LaunchesApi = ReturnType<typeof createLaunchesApi>;

/** The window's command-scope binding (the counted shim, plan item 3002). */
export const {
  launchBuildPipeline,
  startFeaturePlanBuild,
  launchMultiReview,
  getMultiReviewLaunchDefaults,
} = createLaunchesApi(commandBackendClient);
