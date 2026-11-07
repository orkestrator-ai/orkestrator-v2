/**
 * One-request launches: the renderer states what the user chose and the
 * backend fills the saved defaults, owns every step and compensates failures.
 *
 * Each has an older-backend answer in the caller, chosen with
 * `isUnsupportedBackendCommand` (`./shared`) and listed in
 * `docs/architecture/version-compatibility.md`.
 */
import { invoke } from "@/lib/native/backend";
import type { BuildPipeline as BackendBuildPipeline } from "@orkestrator/protocol/build-pipeline";
import type { LaunchBuildPipelineInput } from "@orkestrator/protocol/build-pipeline-defaults";
import type {
  StartFeaturePlanBuildInput,
  StartFeaturePlanBuildResult,
} from "@orkestrator/protocol/feature-build";
import type {
  LaunchMultiReviewActionInput,
  MultiReviewActionResult,
} from "@orkestrator/protocol/multi-review";

/** The Build button: the ticket and only the choices the user made. */
export async function launchBuildPipeline(
  input: LaunchBuildPipelineInput,
): Promise<BackendBuildPipeline> {
  return invoke<BackendBuildPipeline>("launch_build_pipeline", { ...input });
}

/** The Features view's Build: the backend claims, creates the ticket and starts. */
export async function startFeaturePlanBuild(
  input: StartFeaturePlanBuildInput,
): Promise<StartFeaturePlanBuildResult> {
  return invoke<StartFeaturePlanBuildResult>("start_feature_plan_build", { ...input });
}

/**
 * The Multi Review button. `input.requestId` also reserves the workflow id, so
 * a retry after a lost answer reattaches instead of starting a second review.
 */
export async function launchMultiReview(
  input: LaunchMultiReviewActionInput,
): Promise<MultiReviewActionResult> {
  return invoke<MultiReviewActionResult>("launch_multi_review", {
    input: { ...input },
    reservedId: input.requestId,
  });
}
