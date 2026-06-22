import type {
  BuildPipeline,
  PipelineSessionPhase,
  ResumableBuildPhase,
} from "@/stores/buildPipelineStore";

const RESUME_PHASE_BY_SESSION_PHASE: Record<PipelineSessionPhase, ResumableBuildPhase> = {
  build: "building",
  review: "reviewing",
  verify: "verifying",
  fix: "fixing",
  pr: "creating-pr",
  "resolve-conflicts": "resolving-conflicts",
};

export function getPipelineResumePhase(
  pipeline: Pick<BuildPipeline, "pausedFromPhase" | "sessions" | "currentSessionIndex">,
): ResumableBuildPhase | undefined {
  if (pipeline.pausedFromPhase) {
    return pipeline.pausedFromPhase;
  }

  const currentSession = pipeline.sessions[pipeline.currentSessionIndex];
  if (currentSession) {
    return RESUME_PHASE_BY_SESSION_PHASE[currentSession.phase];
  }

  return "waiting-for-setup";
}

export function createPipelineResumePrompt(phase: ResumableBuildPhase): string | null {
  switch (phase) {
    case "building":
      return "Resume the build pipeline from where you left off. Continue implementing the original ticket, incorporate any messages I sent while the pipeline was paused, validate the work as appropriate, and stop when the implementation is ready for review. Do not ask questions; make sensible assumptions.";
    case "reviewing":
      return "Resume the build pipeline review from where you left off. Continue reviewing the current changes against the original ticket and target branch, incorporate any messages I sent while the pipeline was paused, and finish with clear findings. Do not ask questions; make sensible assumptions.";
    case "addressing":
      return "Resume addressing the review findings from where you left off. Incorporate any messages I sent while the pipeline was paused, make the required code and test changes, and validate the result as appropriate. Do not ask questions; make sensible assumptions.";
    case "verifying":
      return "Resume verification from where you left off. Re-check the current codebase against the original ticket, incorporate any messages I sent while the pipeline was paused, and respond with only the JSON object required by the verification instructions.";
    case "fixing":
      return "Resume fixing the verification failures from where you left off. Incorporate any messages I sent while the pipeline was paused, finish the requested fixes, and validate the result as appropriate. Do not ask questions; make sensible assumptions.";
    case "creating-pr":
      return "Resume creating the pull request from where you left off. Incorporate any messages I sent while the pipeline was paused, push or prepare the branch as needed, and create the PR against the target branch if it is not already created. Do not ask questions; make sensible assumptions.";
    case "resolving-conflicts":
      return "Resume resolving PR merge conflicts from where you left off. Incorporate any messages I sent while the pipeline was paused, finish the conflict resolution, and validate the result as appropriate. Do not ask questions; make sensible assumptions.";
    case "creating-environment":
    case "starting-environment":
    case "waiting-for-setup":
      return null;
  }
}
