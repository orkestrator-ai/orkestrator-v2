import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import {
  isBuildPipeline,
  isStartBuildPipelineInput,
  UNATTENDED_AGENT_INTERACTION_POLICY,
} from "./commands-dependencies.js";
import type { StartBuildPipelineInput } from "./commands-dependencies.js";
import {
  asString,
  asBoolean,
  asNonBlankString,
  asRequiredBoolean,
  toClientEnvironment,
} from "./commands-helpers.js";
import { createFeatureBuild } from "./feature-build.js";
import {
  conditionalBuildPipelineRead,
  withoutTranscriptBodies,
} from "./build-pipeline-transcript-projection.js";

export function registerBuildPipelineCommands(
  register: CommandRegistrar,
  dependencies: RegistryDependencies,
): void {
  const { conditionalManifestSnapshot } = dependencies;
  register("start_build_pipeline", (args, context) => {
    if (!context.buildPipelines) throw new Error("Build pipeline supervisor is unavailable");
    if (!isStartBuildPipelineInput(args)) {
      throw new Error("Invalid build pipeline start request");
    }
    return context.buildPipelines.start(args as StartBuildPipelineInput);
  });
  /**
   * Creates the ticket and the build for it in one backend-owned step, so a
   * renderer that navigates away mid-flight cannot leave one without the other.
   */
  register("create_feature_build", (args, context) => createFeatureBuild(args, context));
  register("pause_build_pipeline", ({ pipelineId }, context) => {
    if (!context.buildPipelines) throw new Error("Build pipeline supervisor is unavailable");
    return context.buildPipelines.pause(asNonBlankString(pipelineId, "pipelineId"));
  });
  register("resume_build_pipeline", ({ pipelineId }, context) => {
    if (!context.buildPipelines) throw new Error("Build pipeline supervisor is unavailable");
    return context.buildPipelines.resume(asNonBlankString(pipelineId, "pipelineId"));
  });
  register("cancel_build_pipeline", ({ pipelineId }, context) => {
    if (!context.buildPipelines) throw new Error("Build pipeline supervisor is unavailable");
    return context.buildPipelines.cancel(asNonBlankString(pipelineId, "pipelineId"));
  });
  register("send_build_pipeline_message", ({ pipelineId, text }, context) => {
    if (!context.buildPipelines) throw new Error("Build pipeline supervisor is unavailable");
    return context.buildPipelines.sendMessage(
      asNonBlankString(pipelineId, "pipelineId"),
      asString(text, "text"),
    );
  });
  // Retained for existing command clients that explicitly re-review a working
  // tree, including from a failed pipeline. The header uses current-step restart.
  register("retry_build_pipeline_review", ({ pipelineId }, context) => {
    if (!context.buildPipelines) throw new Error("Build pipeline supervisor is unavailable");
    return context.buildPipelines.retryReview(asNonBlankString(pipelineId, "pipelineId"));
  });
  register("retry_build_pipeline_stage", ({ pipelineId }, context) => {
    if (!context.buildPipelines) throw new Error("Build pipeline supervisor is unavailable");
    return context.buildPipelines.retryStage(asNonBlankString(pipelineId, "pipelineId"));
  });
  register("restart_build_pipeline_step", ({ pipelineId, stageId }, context) => {
    if (!context.buildPipelines) throw new Error("Build pipeline supervisor is unavailable");
    return context.buildPipelines.restartStep(
      asNonBlankString(pipelineId, "pipelineId"),
      asNonBlankString(stageId, "stageId"),
    );
  });
  register("restart_build_pipeline_current_step", ({ pipelineId }, context) => {
    if (!context.buildPipelines) throw new Error("Build pipeline supervisor is unavailable");
    return context.buildPipelines.restartCurrentStep(asNonBlankString(pipelineId, "pipelineId"));
  });
  register("retry_build_pipeline_interaction_failure", ({ pipelineId }, context) => {
    if (!context.buildPipelines) throw new Error("Build pipeline supervisor is unavailable");
    return context.buildPipelines.retryInteractionFailure(
      asNonBlankString(pipelineId, "pipelineId"),
    );
  });
  register("retry_build_pipeline_completion_comment", ({ pipelineId }, context) => {
    if (!context.buildPipelines) throw new Error("Build pipeline supervisor is unavailable");
    return context.buildPipelines.retryCompletionComment(
      asNonBlankString(pipelineId, "pipelineId"),
    );
  });
  register("import_legacy_build_pipelines", ({ projectId, snapshots }, context) => {
    if (!context.buildPipelines) throw new Error("Build pipeline supervisor is unavailable");
    const id = asNonBlankString(projectId, "projectId");
    if (!Array.isArray(snapshots)) {
      throw new Error("Expected snapshots to be an array");
    }
    if (snapshots.length > 100) {
      throw new Error("Legacy build pipeline import is limited to 100 snapshots");
    }
    return context.buildPipelines.importLegacy(id, snapshots);
  });
  /**
   * Control state for one pipeline. Transcript bodies are never embedded:
   * a caller that names the transcript revision/count it holds per session in
   * `knownSessions` receives only the windows its stale sessions need, read
   * from the referenced transcript records (plan step 16).
   */
  register(
    "get_build_pipeline",
    async ({ pipelineId, knownRevision, knownSessions, prioritySessionKey }, { storage }) => {
      const record = await storage.getBuildPipeline(asNonBlankString(pipelineId, "pipelineId"));
      if (!record) return null;
      if (knownSessions && typeof knownSessions === "object" && !Array.isArray(knownSessions)) {
        return conditionalBuildPipelineRead(storage, record, {
          knownRevision,
          knownSessions: knownSessions as Record<string, unknown>,
          prioritySessionKey,
        });
      }
      if (Number.isSafeInteger(knownRevision) && knownRevision === record.revision) {
        return { unchanged: true, revision: record.revision };
      }
      return withoutTranscriptBodies(record);
    },
  );
  /**
   * Explicit downgrade export of one pipeline in the pre-split inline schema,
   * bounded by the old 32 MiB snapshot limit. Read-only.
   */
  register("export_build_pipeline_for_downgrade", ({ pipelineId }, { storage }) =>
    storage.exportBuildPipelineForDowngrade(asNonBlankString(pipelineId, "pipelineId")),
  );
  register(
    "get_build_pipeline_session_projection",
    async ({ pipelineId, sessionKey, refreshUsage }, context) => {
      if (!context.nativeAgents) throw new Error("Native agent service is unavailable");
      const id = asNonBlankString(pipelineId, "pipelineId");
      const key = asNonBlankString(sessionKey, "sessionKey");
      const shouldRefreshUsage =
        refreshUsage === undefined ? undefined : asRequiredBoolean(refreshUsage, "refreshUsage");
      const record = await context.storage.getBuildPipeline(id);
      const snapshot = record?.snapshot;
      const pipeline =
        record && snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
          ? { ...snapshot, controller: "backend" as const, backendRevision: record.revision }
          : null;
      if (!pipeline || !isBuildPipeline(pipeline)) {
        throw new Error("Build pipeline is unavailable");
      }
      const session = pipeline.sessions.find((candidate) => candidate.sessionKey === key);
      if (!session) throw new Error("Build pipeline session is unavailable");
      const agent = session.agent ?? pipeline.agentType;
      const identity = {
        environmentId: pipeline.environmentId,
        agent,
        logicalSessionKey: session.sessionKey,
      };
      return context.nativeAgents.inspectSession({
        ...identity,
        providerSessionId: session.sdkSessionId,
        origin: session.origin ?? "build-pipeline",
        interactionPolicy: session.interactionPolicy ?? UNATTENDED_AGENT_INTERACTION_POLICY,
        title: session.label,
        phase: session.phase,
        refreshUsage: shouldRefreshUsage,
      });
    },
  );
  register("list_build_pipelines", async (args, { storage }) =>
    conditionalManifestSnapshot(args, storage, "build-pipeline", async () => {
      const { projectId, knownRevisions } = args;
      // Summaries never reattach transcript bodies; an unmigrated legacy
      // record is stripped here too.
      const records = (
        await storage.listBuildPipelines(asNonBlankString(projectId, "projectId"))
      ).map(withoutTranscriptBodies);
      if (!knownRevisions || typeof knownRevisions !== "object" || Array.isArray(knownRevisions)) {
        return records;
      }
      const revisions = knownRevisions as Record<string, unknown>;
      return {
        ids: records.map((record) => record.id),
        records: records.filter((record) => revisions[record.id] !== record.revision),
      };
    }),
  );
  register("save_build_pipeline", () => {
    throw new Error("Build pipeline state is backend-owned");
  });
  register("delete_build_pipeline", ({ pipelineId }, context) => {
    const id = asNonBlankString(pipelineId, "pipelineId");
    return context.buildPipelines
      ? context.buildPipelines.remove(id)
      : context.storage.deleteBuildPipeline(id);
  });
  register("clear_task_build_status", async ({ taskId }, context) => {
    const id = asNonBlankString(taskId, "taskId");
    const task = await context.storage.getKanbanTask(id);
    if (!task) throw new Error(`Kanban task not found: ${id}`);
    const records = await context.storage.listBuildPipelines(task.projectId);
    const pipelineIds = new Set(
      records
        .filter((record) => {
          const snapshot = record.snapshot as { taskId?: unknown };
          return snapshot.taskId === id;
        })
        .map((record) => record.id),
    );
    if (task.buildPipelineId) pipelineIds.add(task.buildPipelineId);
    // Keep the task linked until every pipeline is gone. The link is the
    // durable retry marker: after any failure the same idempotent command sees
    // the remaining records and continues, while the UI never claims cleanup
    // succeeded with live work left behind.
    for (const pipelineId of pipelineIds) {
      if (context.buildPipelines) await context.buildPipelines.remove(pipelineId);
      else await context.storage.deleteBuildPipeline(pipelineId);
    }
    const updated = await context.storage.updateKanbanTask(id, {
      environmentId: undefined,
      buildPipelineId: undefined,
      prUrl: "",
      prState: undefined,
    });
    return {
      task: updated,
      removedPipelineIds: [...pipelineIds],
    };
  });

  register(
    "set_environment_unread",
    async ({ environmentId, unread, expectedLastActivityAt }, { storage }) =>
      toClientEnvironment(
        await storage.setEnvironmentUnread(
          asString(environmentId, "environmentId"),
          asBoolean(unread),
          expectedLastActivityAt === undefined || expectedLastActivityAt === null
            ? expectedLastActivityAt
            : asString(expectedLastActivityAt, "expectedLastActivityAt"),
        ),
      ),
  );
}
