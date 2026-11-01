/**
 * The Build button's launch: a ticket and only the choices the user made.
 *
 * The renderer's build launchers used to merge the saved Build defaults
 * themselves and send a complete `start_build_pipeline` request, while the
 * coordinator, the public `build.launch` action and the CLI had the backend
 * merge them (`buildPipelineInputWithDefaults`). The two merges drifted. Now
 * every launcher sends only its explicit overrides and this one path fills
 * the rest from the saved settings, so a build started from any client runs
 * the same workflow.
 *
 * Semantics (shared with the coordinator and `build.launch`):
 * - An explicit step replaces the saved one; a step that names no agent
 *   carries only instructions and keeps the saved selection.
 * - The build step's agent, when named, is the pipeline agent; otherwise
 *   `agentType`; otherwise the first enabled default agent.
 * - Explicit reviewers replace the saved Multi Review rows; otherwise the saved
 *   rows run, with an explicit review step replacing the first. The review
 *   step is always the first reviewer, so a one-reviewer pipeline cannot run
 *   a different model from the one the launcher showed.
 * - Preparation/consolidation is the explicit one, else the saved one when the
 *   pipeline fans out to more than one reviewer.
 */
import {
  isStartBuildPipelineInput,
  type BuildPipeline,
  type StartBuildPipelineInput,
} from "@orkestrator/protocol/build-pipeline";
import type { CommandContext } from "./commands-context.js";
import {
  buildPipelineInputWithDefaults,
  savedLaunchSettings,
} from "./coordinator-launch-defaults.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The start request with every omitted choice filled from the saved Build defaults. */
export async function buildPipelineStartWithSavedDefaults(
  args: unknown,
  context: Pick<CommandContext, "storage">,
): Promise<StartBuildPipelineInput> {
  if (!isRecord(args) || typeof args.projectId !== "string" || !args.projectId.trim()) {
    throw new Error("Invalid build pipeline start request");
  }
  const projectId = args.projectId;
  const input = buildPipelineInputWithDefaults(
    args,
    savedLaunchSettings(await context.storage.loadConfig(), projectId),
  );
  if (!isStartBuildPipelineInput(input) || input.projectId !== projectId) {
    throw new Error("Invalid build pipeline start request");
  }
  return input;
}

/** `launch_build_pipeline`: fill the saved defaults, then start (idempotent by admission key). */
export async function launchBuildPipeline(
  args: unknown,
  context: Pick<CommandContext, "storage" | "buildPipelines">,
): Promise<BuildPipeline> {
  if (!context.buildPipelines) throw new Error("Build pipeline supervisor is unavailable");
  const input = await buildPipelineStartWithSavedDefaults(args, context);
  return context.buildPipelines.start(input);
}
