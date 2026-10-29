/**
 * `update-ticket` (plan P2.7): the Build Pipeline's Kanban lifecycle as a
 * node. It moves the run's ticket to a column, comments on it, or records
 * the acceptance criteria results of a `verification-verdict@1` — or makes
 * one of the pipeline's own updates (`lifecycle`), read from the same table
 * the pipeline uses (`build-pipeline-kanban-lifecycle.ts`).
 *
 * Like `updateKanbanLifecycle` in `build-pipeline-service-recovery.ts`, it
 * compares before it writes: a column or pull request link is set only when
 * it differs, a comment is added only when the ticket does not already have
 * that exact text, and criteria results are set (never appended) on the
 * criteria whose id and text still match, as Verify's are. The whole update
 * is journaled per run, node and iteration (`update-ticket:<slot>`), so a
 * retry or restart that finds it done changes nothing, and one that finds it
 * interrupted repeats only what is still missing.
 *
 * The ticket is `taskId`, else the Kanban ticket linked to the run's
 * environment (the task's `environmentId`, which the launcher sets).
 */
import {
  isAcceptanceCriterionStatus,
  TICKET_SECTION_LIMITS,
} from "@orkestrator/protocol/ticket-sections";
import type { GraphTicketLifecycleEvent } from "@orkestrator/protocol/graphs/system-actions";
import type { GraphTicketV1 } from "@orkestrator/protocol/graphs/types";
import {
  buildPipelineKanbanUpdate,
  type BuildPipelineKanbanUpdate,
} from "./build-pipeline-kanban-lifecycle.js";
import {
  GraphSystemActionError,
  type GraphSystemActionContext,
  type GraphSystemActionHandler,
} from "./graph-system-action.js";

interface VerdictValue {
  acceptanceCriteria: Array<{ id: string; status: string; evidence: string }>;
}

type StoredTask = Awaited<
  ReturnType<GraphSystemActionContext["deps"]["storage"]["kanban"]["getKanbanTasks"]>
>[number];

async function findTask(ctx: GraphSystemActionContext): Promise<StoredTask> {
  const tasks = await ctx.deps.storage.kanban.getKanbanTasks(ctx.run.projectId);
  const taskId = typeof ctx.params.taskId === "string" ? ctx.params.taskId : undefined;
  const task = taskId
    ? tasks.find((candidate) => candidate.id === taskId)
    : tasks.find((candidate) => candidate.environmentId === ctx.environmentId);
  if (!task) {
    throw new GraphSystemActionError(
      taskId
        ? `Kanban ticket ${taskId} was not found in the run's project`
        : "No Kanban ticket is linked to the run's environment; set the node's taskId",
    );
  }
  return task;
}

async function plannedUpdate(ctx: GraphSystemActionContext): Promise<BuildPipelineKanbanUpdate> {
  const lifecycle = ctx.params.lifecycle as GraphTicketLifecycleEvent | undefined;
  if (lifecycle) {
    const pr =
      lifecycle === "pr-raised"
        ? await ctx.requireInput<{ url: string }>("pr-result@1")
        : undefined;
    return buildPipelineKanbanUpdate(lifecycle, pr ? { url: pr.url, state: "open" } : undefined);
  }
  return {
    ...(typeof ctx.params.status === "string"
      ? { status: ctx.params.status as BuildPipelineKanbanUpdate["status"] }
      : {}),
    ...(typeof ctx.params.comment === "string" ? { comment: ctx.params.comment } : {}),
  };
}

/** Verify's checks for the verdict's criteria, with the criterion text they were judged on. */
async function criteriaChecks(ctx: GraphSystemActionContext, task: StoredTask) {
  const verdict = await ctx.requireInput<VerdictValue>("verification-verdict@1");
  const ticket = await ctx.input<GraphTicketV1>("ticket@1");
  const texts = new Map<string, string>(
    (ticket?.criteria ?? task.sections?.acceptanceCriteria ?? []).map((criterion) => [
      criterion.id,
      criterion.text,
    ]),
  );
  const checkedAt = ctx.now().toISOString();
  return verdict.acceptanceCriteria.flatMap((result) => {
    const text = texts.get(result.id);
    if (!text || !isAcceptanceCriterionStatus(result.status)) return [];
    return [
      {
        id: result.id,
        text,
        check: {
          status: result.status,
          evidence: result.evidence.slice(0, TICKET_SECTION_LIMITS.maxEvidenceLength),
          checkedAt,
          source: "verify" as const,
        },
      },
    ];
  });
}

export const updateTicketAction: GraphSystemActionHandler = {
  action: "update-ticket",
  async run(ctx) {
    const update = await plannedUpdate(ctx);
    const recordCriteria = ctx.params.record === "criteria";
    await ctx.effect(ctx.slotKey(), async () => {
      const task = await findTask(ctx);
      const kanban = ctx.deps.storage.kanban;
      const moves =
        (update.status !== undefined && task.status !== update.status) ||
        (update.prUrl !== undefined && task.prUrl !== update.prUrl) ||
        (update.prState !== undefined && task.prState !== update.prState);
      if (moves) {
        await kanban.updateKanbanTask(task.id, {
          ...(update.status ? { status: update.status } : {}),
          ...(update.prUrl ? { prUrl: update.prUrl } : {}),
          ...(update.prState ? { prState: update.prState } : {}),
        });
      }
      const comment =
        update.comment !== undefined &&
        !task.comments.some((existing) => existing.text === update.comment);
      if (comment) await kanban.addKanbanComment(task.id, update.comment!);
      let criteria = 0;
      if (recordCriteria) {
        const checks = await criteriaChecks(ctx, task);
        if (checks.length > 0) await kanban.recordKanbanCriteriaChecks(task.id, checks);
        criteria = checks.length;
      }
      return { taskId: task.id, moved: moves, commented: comment, criteria };
    });
  },
};
