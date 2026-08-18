import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import type { PrState } from "./commands-dependencies.js";
import {
  asString,
  asFeaturePlanUpdates,
  asFeaturePlanRole,
  asFeaturePlanStateApplication,
  asFeaturePlanModelId,
  asStartFeaturePlanningInput,
  requireFeaturePlanning,
  asNonBlankString,
  assertOnlyKeys,
} from "./commands-helpers.js";

export function registerKanbanCommands(
  register: CommandRegistrar,
  dependencies: RegistryDependencies,
): void {
  const { conditionalManifestSnapshot } = dependencies;
  register("get_kanban_tasks", (args, { storage }) =>
    conditionalManifestSnapshot(args, storage, "kanban", () =>
      storage.getKanbanTasks(asString(args.projectId, "projectId")),
    ),
  );
  register("add_kanban_task", ({ projectId, title, description }, { storage }) =>
    storage.addKanbanTask(
      asString(projectId, "projectId"),
      asString(title, "title"),
      asString(description, "description"),
    ),
  );
  register(
    "update_kanban_task",
    (
      {
        taskId,
        title,
        description,
        acceptanceCriteria,
        status,
        environmentId,
        buildPipelineId,
        prUrl,
        prState,
        prMergeCommented,
      },
      { storage },
    ) =>
      storage.updateKanbanTask(asString(taskId, "taskId"), {
        ...(typeof title === "string" ? { title } : {}),
        ...(typeof description === "string" ? { description } : {}),
        ...(typeof acceptanceCriteria === "string" ? { acceptanceCriteria } : {}),
        ...(typeof status === "string" ? { status: status as never } : {}),
        ...(typeof environmentId === "string" ? { environmentId: environmentId || undefined } : {}),
        ...(typeof buildPipelineId === "string"
          ? { buildPipelineId: buildPipelineId || undefined }
          : {}),
        ...(typeof prUrl === "string" ? { prUrl: prUrl || undefined } : {}),
        ...(typeof prState === "string" ? { prState: prState as PrState } : {}),
        ...(typeof prMergeCommented === "boolean" ? { prMergeCommented } : {}),
      }),
  );
  register("delete_kanban_task", ({ taskId }, { storage }) =>
    storage.deleteKanbanTask(asString(taskId, "taskId")),
  );
  register("add_kanban_comment", ({ taskId, text }, { storage }) =>
    storage.addKanbanComment(asString(taskId, "taskId"), asString(text, "text")),
  );
  register("delete_kanban_comment", ({ taskId, commentId }, { storage }) =>
    storage.deleteKanbanComment(asString(taskId, "taskId"), asString(commentId, "commentId")),
  );
  register("add_kanban_image", ({ taskId, filename, data }, { storage }) =>
    storage.addKanbanImage(
      asString(taskId, "taskId"),
      asString(filename, "filename"),
      asString(data, "data"),
    ),
  );
  register("delete_kanban_image", ({ taskId, imageId }, { storage }) =>
    storage.deleteKanbanImage(asString(taskId, "taskId"), asString(imageId, "imageId")),
  );
  register("get_kanban_image_data", ({ imageId }, { storage }) =>
    storage.getKanbanImageData(asString(imageId, "imageId")),
  );
  register("get_project_notes", (args, { storage }) =>
    conditionalManifestSnapshot(args, storage, "project-notes", () =>
      storage.getProjectNotes(asString(args.projectId, "projectId")),
    ),
  );
  register("save_project_notes", ({ projectId, content }, { storage }) =>
    storage.saveProjectNotes(asString(projectId, "projectId"), asString(content, "content")),
  );
  register("get_feature_plans", (args, { storage }) =>
    conditionalManifestSnapshot(args, storage, "feature-plan", () =>
      storage.getFeaturePlans(asString(args.projectId, "projectId")),
    ),
  );
  register("create_feature_plan", ({ projectId }, { storage }) =>
    storage.createFeaturePlan(asString(projectId, "projectId")),
  );
  register("update_feature_plan", (args, { storage }) => {
    assertOnlyKeys(args, ["featureId", "updates"], "arguments");
    return storage.updateFeaturePlan(
      asNonBlankString(args.featureId, "featureId"),
      asFeaturePlanUpdates(args.updates),
    );
  });
  register("claim_feature_plan_build", ({ featureId, taskId }, { storage }) =>
    storage.claimFeaturePlanBuild(asString(featureId, "featureId"), asString(taskId, "taskId")),
  );
  register(
    "append_feature_plan_message",
    ({ featureId, role, content, stateApplication, modelId }, { storage }) =>
      storage.appendFeaturePlanMessage(
        asString(featureId, "featureId"),
        asFeaturePlanRole(role),
        asString(content, "content"),
        asFeaturePlanStateApplication(stateApplication),
        asFeaturePlanModelId(modelId),
      ),
  );
  register(
    "append_feature_story_message",
    ({ featureId, storyId, role, content, stateApplication, modelId }, { storage }) =>
      storage.appendFeatureStoryMessage(
        asString(featureId, "featureId"),
        asString(storyId, "storyId"),
        asFeaturePlanRole(role),
        asString(content, "content"),
        asFeaturePlanStateApplication(stateApplication),
        asFeaturePlanModelId(modelId),
      ),
  );

  // Backend-owned planning workflow. The renderer sends the user's message and
  // then renders the record; every step after this — environment, bridge,
  // session, dispatch, reply, parse, persist — happens without it.
  register("start_feature_planning", (args, context) => {
    assertOnlyKeys(args, ["featureId", "kind", "storyId", "userMessage"], "arguments");
    return requireFeaturePlanning(context).start(asStartFeaturePlanningInput(args));
  });
  register("get_feature_planning_snapshot", (args, context) => {
    assertOnlyKeys(args, ["projectId"], "arguments");
    return requireFeaturePlanning(context).snapshot(asNonBlankString(args.projectId, "projectId"));
  });
  register("retry_feature_planning", (args, context) => {
    assertOnlyKeys(args, ["featureId"], "arguments");
    return requireFeaturePlanning(context).retry(asNonBlankString(args.featureId, "featureId"));
  });
  register("cancel_feature_planning", (args, context) => {
    assertOnlyKeys(args, ["featureId"], "arguments");
    return requireFeaturePlanning(context).cancel(asNonBlankString(args.featureId, "featureId"));
  });
}
