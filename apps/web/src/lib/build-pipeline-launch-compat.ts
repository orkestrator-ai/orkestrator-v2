/**
 * A build launch against a backend older than `launch_build_pipeline`.
 *
 * Such a backend starts exactly what it is told, so the saved defaults have to
 * be merged here, as this renderer did before the backend took that over. This
 * is frozen compatibility code, not a second implementation to keep in step:
 * new semantics go in the backend's `buildPipelineInputWithDefaults`. Listed in
 * `docs/architecture/version-compatibility.md`; delete it when its row retires.
 */
import type {
  BuildStepConfigs,
  StartBuildPipelineInput,
} from "@orkestrator/protocol/build-pipeline";
import type { LaunchBuildPipelineInput } from "@orkestrator/protocol/build-pipeline-defaults";
import { buildPipelineConfiguredDefaults } from "@/lib/build-launch-options";
import { resolveBuildPipelineAgent } from "@/lib/build-pipeline-agent";
import type { AppConfig } from "@/types";

export function legacyBuildPipelineStartInput(
  config: AppConfig,
  request: LaunchBuildPipelineInput,
): StartBuildPipelineInput {
  const configured = buildPipelineConfiguredDefaults(config, request.projectId);
  const steps: BuildStepConfigs = {
    ...configured.steps,
    ...request.steps,
  };
  const reviewers = request.reviewers
    ? request.reviewers
    : configured.reviewers.map((reviewer, index) =>
        index === 0 && steps.review ? steps.review : reviewer,
      );
  const reviewPreparation = request.reviewPreparation ?? configured.reviewPreparation;
  return {
    ...request,
    agentType:
      steps.build?.agent ??
      request.agentType ??
      resolveBuildPipelineAgent(config, request.projectId),
    steps,
    reviewers,
    ...(reviewPreparation ? { reviewPreparation } : {}),
  };
}
