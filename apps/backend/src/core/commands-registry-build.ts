import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import { isStartBuildPipelineInput } from "./commands-dependencies.js";
import type { StartBuildPipelineInput } from "./commands-dependencies.js";
import { asString, asBoolean, asNonBlankString, toClientEnvironment } from "./commands-helpers.js";

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
  register("retry_build_pipeline_review", ({ pipelineId }, context) => {
    if (!context.buildPipelines) throw new Error("Build pipeline supervisor is unavailable");
    return context.buildPipelines.retryReview(asNonBlankString(pipelineId, "pipelineId"));
  });
  register("retry_build_pipeline_stage", ({ pipelineId }, context) => {
    if (!context.buildPipelines) throw new Error("Build pipeline supervisor is unavailable");
    return context.buildPipelines.retryStage(asNonBlankString(pipelineId, "pipelineId"));
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
  register(
    "get_build_pipeline",
    async ({ pipelineId, knownRevision, knownSessions }, { storage }) => {
      const record = await storage.getBuildPipeline(asNonBlankString(pipelineId, "pipelineId"));
      if (record && Number.isSafeInteger(knownRevision) && knownRevision === record.revision) {
        return { unchanged: true, revision: record.revision };
      }
      if (
        record &&
        knownRevision !== undefined &&
        knownSessions &&
        typeof knownSessions === "object" &&
        !Array.isArray(knownSessions) &&
        record.snapshot &&
        typeof record.snapshot === "object" &&
        !Array.isArray(record.snapshot) &&
        Array.isArray((record.snapshot as { sessions?: unknown }).sessions)
      ) {
        const cursors = knownSessions as Record<string, unknown>;
        const snapshot = record.snapshot as Record<string, unknown>;
        const messagePatches: Array<Record<string, unknown>> = [];
        const sessions = (snapshot.sessions as unknown[]).map((value) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) return value;
          const session = value as Record<string, unknown>;
          const sessionKey = session.sessionKey;
          const messages = session.messages;
          const revision = session.messageRevision;
          if (
            typeof sessionKey !== "string" ||
            !Array.isArray(messages) ||
            !Number.isSafeInteger(revision)
          ) {
            return session;
          }
          const cursor = cursors[sessionKey];
          const cursorRecord =
            cursor && typeof cursor === "object" && !Array.isArray(cursor)
              ? (cursor as Record<string, unknown>)
              : undefined;
          const baseRevision = cursorRecord?.revision;
          const baseCount = cursorRecord?.count;
          if (baseRevision === revision && baseCount === messages.length) {
            const { messages: _messages, ...withoutMessages } = session;
            return withoutMessages;
          }
          const usableBase =
            Number.isSafeInteger(baseRevision) &&
            (baseRevision as number) >= 0 &&
            (baseRevision as number) < (revision as number) &&
            Number.isSafeInteger(baseCount) &&
            (baseCount as number) >= 0 &&
            (baseCount as number) <= messages.length;
          const startIndex = usableBase ? Math.max(0, (baseCount as number) - 1) : 0;
          messagePatches.push({
            sessionKey,
            ...(usableBase ? { baseRevision, baseCount } : {}),
            startIndex,
            revision,
            messages: messages.slice(startIndex),
          });
          const { messages: _messages, ...withoutMessages } = session;
          return withoutMessages;
        });
        return {
          unchanged: false,
          record: {
            ...record,
            snapshot: { ...snapshot, sessions },
          },
          messagePatches,
        };
      }
      return record;
    },
  );
  register("list_build_pipelines", async (args, { storage }) =>
    conditionalManifestSnapshot(args, storage, "build-pipeline", async () => {
      const { projectId, knownRevisions } = args;
      const records = await storage.listBuildPipelines(asNonBlankString(projectId, "projectId"));
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
