import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import type { PrState } from "./models.js";
import {
  isAcceptanceCriterionCheck,
  isTicketKind,
  parseTicketSectionsPatch,
  TICKET_KINDS,
  TICKET_SECTION_LIMITS,
} from "@orkestrator/protocol/ticket-sections";
import { normalizeTicketLabels } from "@orkestrator/protocol/ticket-labels";
import type { KanbanTaskContentInput } from "./storage-kanban.js";
import { readKanbanImageData } from "./ticket-sync-images.js";
import { parseKanbanLabelInput } from "./storage-kanban-labels.js";
import { ASYNC_HANDLER } from "./commands-registry-async-decode.js";
import {
  addKanbanCommentCommand,
  addKanbanImageCommand,
  addKanbanTaskCommand,
  appendFeaturePlanMessageCommand,
  appendFeatureStoryMessageCommand,
  cancelFeaturePlanningCommand,
  claimFeaturePlanBuildCommand,
  closeKanbanTaskForMergedPrCommand,
  createKanbanLabelCommand,
  createFeaturePlanCommand,
  deleteKanbanCommentCommand,
  deleteKanbanImageCommand,
  deleteKanbanTaskCommand,
  getFeaturePlansCommand,
  getKanbanImageDataCommand,
  getKanbanLabelsCommand,
  getKanbanTasksCommand,
  getProjectNotesCommand,
  recordKanbanCriteriaChecksCommand,
  retryFeaturePlanningCommand,
  saveProjectNotesCommand,
  setKanbanTaskLabelCommand,
  startFeaturePlanningCommand,
  updateFeaturePlanCommand,
  updateKanbanTaskCommand,
} from "@orkestrator/protocol/contract/domains/kanban";
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

/** `labels` of a ticket command: absent, or a list of label names (empty clears them). */
function asTicketLabelsInput(args: Record<string, unknown>): { labels?: string[] } {
  if (args.labels === undefined || args.labels === null) return {};
  return { labels: normalizeTicketLabels(args.labels) };
}

/**
 * The `kanban` domain's ticket, notes and feature-plan commands, registered
 * with their definitions (plan item 7008). Arguments decode tolerantly; the
 * handlers keep their own checks and messages, and the nested `checks` items
 * and plan `updates` stay strict (values whose unknown parts would be stored
 * or silently lost, not argument keys).
 */
export function registerKanbanCommands(
  register: CommandRegistrar,
  dependencies: RegistryDependencies,
): void {
  const { conditionalManifestSnapshot } = dependencies;
  register(getKanbanTasksCommand, (args, { storage }) =>
    conditionalManifestSnapshot(args, storage, "kanban", () =>
      storage.kanban.getKanbanTasks(asString(args.projectId, "projectId")),
    ),
  );
  register(addKanbanTaskCommand, (args, { storage }) => {
    const { projectId, title, description, acceptanceCriteria, status, requestId } = args;
    const parsedRequestId = asOptionalMutationRequestId(requestId);
    const initial = {
      ...asTicketContentInput(args),
      ...asTicketLabelsInput(args),
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
  register(updateKanbanTaskCommand, (args, { storage }) => {
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
    return storage.kanban.updateKanbanTask(
      asString(taskId, "taskId"),
      {
        ...asTicketContentInput(args),
        ...asTicketLabelsInput(args),
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
      },
      undefined,
      { preserveDoneStatus: args.preserveDoneStatus === true },
    );
  });
  // A ticket whose pull request merged moves to done, once per pull request
  // (`kanban-merge-closure.ts`). Resolves to whether the ticket moved.
  register(
    closeKanbanTaskForMergedPrCommand,
    async (args, { storage }) => {
      const moved = await storage.kanban.closeKanbanTasksForMergedPullRequests([
        {
          taskId: asNonBlankString(args.taskId, "taskId"),
          prUrl: asNonBlankString(args.prUrl, "prUrl"),
        },
      ]);
      return { closed: moved.length > 0 };
    },
    ASYNC_HANDLER,
  );
  register(recordKanbanCriteriaChecksCommand, (args, { storage }) => {
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
        ["status", "evidence", "checkedAt", "source", "pipelineId", "commit", "uncommittedChanges"],
        `checks[${index}].check`,
      );
      return { id: value.id, text: value.text, check: value.check };
    });
    return storage.kanban.recordKanbanCriteriaChecks(
      asNonBlankString(args.taskId, "taskId"),
      checks,
    );
  });
  register(getKanbanLabelsCommand, (args, { storage }) => {
    return storage.kanban.getKanbanLabels(asNonBlankString(args.projectId, "projectId"));
  });
  register(createKanbanLabelCommand, (args, { storage }) => {
    return storage.kanban.createKanbanLabel(
      asNonBlankString(args.projectId, "projectId"),
      parseKanbanLabelInput({
        name: args.name,
        ...(args.color !== undefined ? { color: args.color } : {}),
        ...(args.description !== undefined ? { description: args.description } : {}),
      }),
    );
  });
  register(setKanbanTaskLabelCommand, (args, { storage }) => {
    if (args.present !== undefined && typeof args.present !== "boolean") {
      throw new Error("present must be a boolean");
    }
    return storage.kanban.setKanbanTaskLabel(
      asNonBlankString(args.taskId, "taskId"),
      asNonBlankString(args.name, "name"),
      args.present !== false,
      args.projectId === undefined ? undefined : asNonBlankString(args.projectId, "projectId"),
    );
  });
  register(deleteKanbanTaskCommand, ({ taskId }, { storage }) =>
    storage.kanban.deleteKanbanTask(asString(taskId, "taskId")),
  );
  register(addKanbanCommentCommand, ({ taskId, text, projectId, requestId }, { storage }) => {
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
  register(deleteKanbanCommentCommand, ({ taskId, commentId }, { storage }) =>
    storage.kanban.deleteKanbanComment(
      asString(taskId, "taskId"),
      asString(commentId, "commentId"),
    ),
  );
  register(addKanbanImageCommand, ({ taskId, filename, data }, { storage }) =>
    storage.kanban.addKanbanImage(
      asString(taskId, "taskId"),
      asString(filename, "filename"),
      asString(data, "data"),
    ),
  );
  register(deleteKanbanImageCommand, ({ taskId, imageId }, { storage }) =>
    storage.kanban.deleteKanbanImage(asString(taskId, "taskId"), asString(imageId, "imageId")),
  );
  register(getKanbanImageDataCommand, ({ imageId }, context) =>
    readKanbanImageData(context, asString(imageId, "imageId")),
  );
  register(getProjectNotesCommand, (args, { storage }) =>
    conditionalManifestSnapshot(args, storage, "project-notes", () =>
      storage.kanban.getProjectNotes(asString(args.projectId, "projectId")),
    ),
  );
  register(saveProjectNotesCommand, ({ projectId, content }, { storage }) =>
    storage.kanban.saveProjectNotes(asString(projectId, "projectId"), asString(content, "content")),
  );
  register(getFeaturePlansCommand, (args, { storage }) =>
    conditionalManifestSnapshot(args, storage, "feature-plan", () =>
      storage.kanban.getFeaturePlans(asString(args.projectId, "projectId")),
    ),
  );
  register(createFeaturePlanCommand, ({ projectId }, { storage }) =>
    storage.kanban.createFeaturePlan(asString(projectId, "projectId")),
  );
  register(updateFeaturePlanCommand, (args, { storage }) => {
    return storage.kanban.updateFeaturePlan(
      asNonBlankString(args.featureId, "featureId"),
      asFeaturePlanUpdates(args.updates),
    );
  });
  register(claimFeaturePlanBuildCommand, ({ featureId, taskId }, { storage }) =>
    storage.kanban.claimFeaturePlanBuild(
      asString(featureId, "featureId"),
      asString(taskId, "taskId"),
    ),
  );
  register(
    appendFeaturePlanMessageCommand,
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
    appendFeatureStoryMessageCommand,
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
  register(startFeaturePlanningCommand, (args, context) => {
    return requireFeaturePlanning(context).start(asStartFeaturePlanningInput(args));
  });
  register(retryFeaturePlanningCommand, (args, context) => {
    return requireFeaturePlanning(context).retry(asNonBlankString(args.featureId, "featureId"));
  });
  register(cancelFeaturePlanningCommand, (args, context) => {
    return requireFeaturePlanning(context).cancel(asNonBlankString(args.featureId, "featureId"));
  });
}
