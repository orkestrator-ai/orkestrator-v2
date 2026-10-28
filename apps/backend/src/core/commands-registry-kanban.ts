import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import type { PrState } from "./models.js";
import {
  isAcceptanceCriterionCheck,
  isTicketKind,
  parseTicketSectionsPatch,
  TICKET_KINDS,
  TICKET_SECTION_LIMITS,
} from "@orkestrator/protocol/ticket-sections";
import type { KanbanTaskContentInput } from "./storage-kanban.js";
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

function asOptionalMutationRequestId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const requestId = asNonBlankString(value, "requestId");
  if (requestId.length > 256) throw new Error("requestId must be at most 256 characters");
  return requestId;
}

/** The structured content fields of a ticket command; absent fields are omitted. */
function asTicketContentInput(args: Record<string, unknown>): KanbanTaskContentInput {
  const { kind, markdown, sections } = args;
  if (kind !== undefined && !isTicketKind(kind)) {
    throw new Error(`kind must be one of ${TICKET_KINDS.join(", ")}`);
  }
  if (markdown !== undefined && typeof markdown !== "string") {
    throw new Error("markdown must be a string");
  }
  return {
    ...(kind !== undefined ? { kind } : {}),
    ...(typeof markdown === "string" ? { markdown } : {}),
    ...(sections !== undefined && sections !== null
      ? { sections: parseTicketSectionsPatch(sections) }
      : {}),
  };
}

export function registerKanbanCommands(
  register: CommandRegistrar,
  dependencies: RegistryDependencies,
): void {
  const { conditionalManifestSnapshot } = dependencies;
  register("get_kanban_tasks", (args, { storage }) =>
    conditionalManifestSnapshot(args, storage, "kanban", () =>
      storage.kanban.getKanbanTasks(asString(args.projectId, "projectId")),
    ),
  );
  register("add_kanban_task", (args, { storage }) => {
    const { projectId, title, description, acceptanceCriteria, status, requestId } = args;
    const parsedRequestId = asOptionalMutationRequestId(requestId);
    const initial = {
      ...asTicketContentInput(args),
      ...(typeof acceptanceCriteria === "string" ? { acceptanceCriteria } : {}),
      ...(typeof status === "string" ? { status: status as never } : {}),
      ...(parsedRequestId ? { requestId: parsedRequestId } : {}),
    };
    const required = [
      asString(projectId, "projectId"),
      asString(title, "title"),
      description === undefined &&
      (initial.markdown !== undefined || initial.sections !== undefined)
        ? undefined
        : asString(description, "description"),
    ] as const;
    return Object.keys(initial).length > 0
      ? storage.kanban.addKanbanTask(...required, initial)
      : storage.kanban.addKanbanTask(...required);
  });
  register("update_kanban_task", (args, { storage }) => {
    const {
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
    } = args;
    return storage.kanban.updateKanbanTask(asString(taskId, "taskId"), {
      ...asTicketContentInput(args),
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
    });
  });
  register("record_kanban_criteria_checks", (args, { storage }) => {
    assertOnlyKeys(args, ["taskId", "checks"], "arguments");
    if (
      !Array.isArray(args.checks) ||
      args.checks.length > TICKET_SECTION_LIMITS.maxAcceptanceCriteria
    ) {
      throw new Error("checks must be an array of criterion results");
    }
    const checks = args.checks.map((entry, index) => {
      const value = entry as Record<string, unknown>;
      if (
        !value ||
        typeof value.id !== "string" ||
        !value.id.trim() ||
        value.id.length > 64 ||
        typeof value.text !== "string" ||
        !value.text.trim() ||
        !isAcceptanceCriterionCheck(value.check)
      ) {
        throw new Error(`checks[${index}] must be { id, text, check }`);
      }
      assertOnlyKeys(value, ["id", "text", "check"], `checks[${index}]`);
      assertOnlyKeys(
        { ...value.check },
        ["status", "evidence", "checkedAt", "source", "pipelineId"],
        `checks[${index}].check`,
      );
      return { id: value.id, text: value.text, check: value.check };
    });
    return storage.kanban.recordKanbanCriteriaChecks(
      asNonBlankString(args.taskId, "taskId"),
      checks,
    );
  });
  register("delete_kanban_task", ({ taskId }, { storage }) =>
    storage.kanban.deleteKanbanTask(asString(taskId, "taskId")),
  );
  register("add_kanban_comment", ({ taskId, text, projectId, requestId }, { storage }) => {
    const parsedRequestId = asOptionalMutationRequestId(requestId);
    const required = [asString(taskId, "taskId"), asString(text, "text")] as const;
    if (projectId === undefined && parsedRequestId === undefined) {
      return storage.kanban.addKanbanComment(...required);
    }
    return storage.kanban.addKanbanComment(
      ...required,
      projectId === undefined ? undefined : asString(projectId, "projectId"),
      parsedRequestId,
    );
  });
  register("delete_kanban_comment", ({ taskId, commentId }, { storage }) =>
    storage.kanban.deleteKanbanComment(
      asString(taskId, "taskId"),
      asString(commentId, "commentId"),
    ),
  );
  register("add_kanban_image", ({ taskId, filename, data }, { storage }) =>
    storage.kanban.addKanbanImage(
      asString(taskId, "taskId"),
      asString(filename, "filename"),
      asString(data, "data"),
    ),
  );
  register("delete_kanban_image", ({ taskId, imageId }, { storage }) =>
    storage.kanban.deleteKanbanImage(asString(taskId, "taskId"), asString(imageId, "imageId")),
  );
  register("get_kanban_image_data", ({ imageId }, { storage }) =>
    storage.kanban.getKanbanImageData(asString(imageId, "imageId")),
  );
  register("get_project_notes", (args, { storage }) =>
    conditionalManifestSnapshot(args, storage, "project-notes", () =>
      storage.kanban.getProjectNotes(asString(args.projectId, "projectId")),
    ),
  );
  register("save_project_notes", ({ projectId, content }, { storage }) =>
    storage.kanban.saveProjectNotes(asString(projectId, "projectId"), asString(content, "content")),
  );
  register("get_feature_plans", (args, { storage }) =>
    conditionalManifestSnapshot(args, storage, "feature-plan", () =>
      storage.kanban.getFeaturePlans(asString(args.projectId, "projectId")),
    ),
  );
  register("create_feature_plan", ({ projectId }, { storage }) =>
    storage.kanban.createFeaturePlan(asString(projectId, "projectId")),
  );
  register("update_feature_plan", (args, { storage }) => {
    assertOnlyKeys(args, ["featureId", "updates"], "arguments");
    return storage.kanban.updateFeaturePlan(
      asNonBlankString(args.featureId, "featureId"),
      asFeaturePlanUpdates(args.updates),
    );
  });
  register("claim_feature_plan_build", ({ featureId, taskId }, { storage }) =>
    storage.kanban.claimFeaturePlanBuild(
      asString(featureId, "featureId"),
      asString(taskId, "taskId"),
    ),
  );
  register(
    "append_feature_plan_message",
    ({ featureId, role, content, stateApplication, modelId }, { storage }) =>
      storage.kanban.appendFeaturePlanMessage(
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
      storage.kanban.appendFeatureStoryMessage(
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
    assertOnlyKeys(
      args,
      ["featureId", "kind", "storyId", "userMessage", "operationId"],
      "arguments",
    );
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
