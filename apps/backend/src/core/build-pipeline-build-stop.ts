/**
 * Acts on a Build turn's decision not to continue to review
 * (`@orkestrator/protocol/build-pipeline-build-outcome`).
 *
 * Called by the supervisor when a Build turn ends, before review package
 * preparation starts, so a build that found nothing to change (or had to stop)
 * spends no preparation, validation, review, Address, Verify or Ship session.
 */
import type { BuildPipeline, PipelineSession } from "@orkestrator/protocol/build-pipeline";
import { pipelineBuildStopSummary } from "@orkestrator/protocol/build-pipeline-build-outcome";

export interface BuildStopHost {
  /** Completes the pipeline (`BuildPipelineRecovery.complete`). */
  complete(pipeline: BuildPipeline): Promise<void>;
  save(pipeline: BuildPipeline): Promise<unknown>;
}

/**
 * Stops the pipeline after `session`'s Build turn when that turn reported
 * `continueReview: false` and the report has not been acted on yet. Resolves
 * whether it stopped; false leaves the pipeline untouched for the usual path.
 *
 * - `no-work-needed` completes the pipeline.
 * - `blocked` pauses it from `building`, with the reason as the pause message.
 *   Resume gives the Build session another turn; the report is marked applied
 *   here, so only a new report from that turn can stop the pipeline again.
 */
export async function stopAfterBuild(
  pipeline: BuildPipeline,
  session: PipelineSession,
  host: BuildStopHost,
  at = new Date().toISOString(),
): Promise<boolean> {
  if (pipeline.phase !== "building" || session.phase !== "build") return false;
  const outcome = session.buildOutcome;
  if (!outcome || outcome.continueReview || outcome.appliedAt) return false;
  const { stopKind, stopReason } = outcome;
  if (!stopKind || !stopReason) return false;
  outcome.appliedAt = at;
  if (stopKind === "no-work-needed") {
    await host.complete(pipeline);
    return true;
  }
  pipeline.pausedFromPhase = "building";
  pipeline.phase = "paused";
  pipeline.pauseCause = "supervisor";
  pipeline.error = `${pipelineBuildStopSummary({ stopKind, stopReason })} Send a message to steer the Build, then Resume to give it another turn, or Cancel the build.`;
  delete pipeline.stallWarning;
  await host.save(pipeline);
  return true;
}
