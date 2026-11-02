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
 * - A "When verified" choice (`deliveryPolicy`) is saved to a Kanban ticket here,
 *   because the ticket is what Build reads when Verify passes. A Linear or GitHub
 *   ticket has nowhere to hold one, so it stays on the pipeline.
 */
import {
  isStartBuildPipelineInput,
  type BuildPipeline,
  type StartBuildPipelineInput,
} from "@orkestrator/protocol/build-pipeline";
import type { DeliveryPolicy } from "@orkestrator/protocol/ticket-sections";
import type { CommandContext } from "./commands-context.js";
import type { KanbanTask } from "./storage-shared.js";
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

/**
 * Saves a launch's delivery policy on its ticket, keeping the delivery note,
 * and returns the ticket as it now reads. Unchanged if it already has it, so a
 * launch never rewrites a ticket's text for a choice the user did not change.
 */
export async function saveTicketDeliveryPolicy(
  storage: CommandContext["storage"],
  task: KanbanTask,
  policy: DeliveryPolicy,
): Promise<KanbanTask> {
  const delivery = task.sections?.delivery;
  if (delivery?.policy === policy) return task;
  return storage.kanban.updateKanbanTask(task.id, {
    sections: { delivery: { ...delivery, policy } },
  });
}

/**
 * A Kanban launch's start request with its policy saved on the ticket first.
 * The snapshot follows the ticket's new text, so the run's Ticket node does not
 * read as edited since launch by the launch itself.
 */
async function withTicketDeliveryPolicy(
  input: StartBuildPipelineInput,
  storage: CommandContext["storage"],
): Promise<StartBuildPipelineInput> {
  if (!input.deliveryPolicy || input.source?.type !== "kanban") return input;
  const task = await storage.kanban.getKanbanTask(input.source.taskId);
  if (!task || task.projectId !== input.projectId) return input;
  const saved = await saveTicketDeliveryPolicy(storage, task, input.deliveryPolicy);
  const snapshot = input.taskSnapshot;
  return {
    ...input,
    taskSnapshot: {
      ...snapshot,
      ...(snapshot.description === task.description ? { description: saved.description } : {}),
      ...(snapshot.acceptanceCriteria === task.acceptanceCriteria
        ? { acceptanceCriteria: saved.acceptanceCriteria }
        : {}),
    },
  };
}

/** `launch_build_pipeline`: fill the saved defaults, then start (idempotent by admission key). */
export async function launchBuildPipeline(
  args: unknown,
  context: Pick<CommandContext, "storage" | "buildPipelines">,
): Promise<BuildPipeline> {
  if (!context.buildPipelines) throw new Error("Build pipeline supervisor is unavailable");
  const input = await buildPipelineStartWithSavedDefaults(args, context);
  return context.buildPipelines.start(await withTicketDeliveryPolicy(input, context.storage));
}
