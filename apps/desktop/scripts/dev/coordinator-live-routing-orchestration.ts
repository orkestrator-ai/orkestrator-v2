import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  CoordinatorSnapshot,
  CoordinatorWorkflowAssociation,
} from "@orkestrator/protocol/coordinator";
import type { CoordinatorLiveCheck, CoordinatorLivePlatformSummary } from "./coordinator-live.js";
import { coordinatorLiveBudgets } from "./coordinator-live-budgets.js";
import {
  createDelegationWatch,
  removeLaunchedEnvironments,
  type DelegationCoordinator,
} from "./coordinator-live-observer.js";
import { coordinatorTurn } from "./coordinator-live-orchestration.js";
import {
  createRoutingRows,
  evaluateRoutingBuild,
  evaluateRoutingDeliveryOutcome,
  evaluateRoutingInteractions,
  evaluateRoutingInvestigate,
  evaluateRoutingReview,
  routingAgentSettings,
  routingBuildPrompt,
  routingDeliveryPrompt,
  routingEnvironmentName,
  routingInvestigatePrompt,
  routingReviewPrompt,
  routingToolCalls,
  workflowCallCounts,
  ROUTING_CASES,
  type RoutingCase,
  type RoutingPipeline,
  type RoutingProbe,
  type RoutingReview,
  type RoutingReviewTarget,
  type RoutingTicket,
} from "./coordinator-live-routing.js";
import { STATUS_REVIEWEE_FILE } from "./coordinator-live-status.js";

type Watch = ReturnType<typeof createDelegationWatch>;

const TERMINAL_PIPELINE_PHASES = new Set(["complete", "failed"]);

/** A list read, or the snapshot inside a conditional answer. */
function listOf<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  const snapshot = (value as { snapshot?: unknown } | null)?.snapshot;
  return Array.isArray(snapshot) ? (snapshot as T[]) : [];
}

/** The pipeline snapshot inside a `get_build_pipeline` answer, whichever shape it has. */
function pipelineSnapshot(value: unknown): RoutingPipeline | undefined {
  const result = value as { record?: { snapshot?: unknown }; snapshot?: unknown } | null;
  const snapshot = result?.record?.snapshot ?? result?.snapshot;
  return snapshot && typeof snapshot === "object" ? (snapshot as RoutingPipeline) : undefined;
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

/** What the backend holds for this project and conversation, read when asked. */
function backendReads(coordinator: DelegationCoordinator) {
  const { invoke, projectId, conversation } = coordinator;
  return {
    async tickets(): Promise<RoutingTicket[]> {
      return listOf<RoutingTicket>(await invoke<unknown>("get_kanban_tasks", { projectId }));
    },
    /** Settled associations of one kind for this conversation; a pending reservation names nothing yet. */
    async associated(kind: CoordinatorWorkflowAssociation["kind"]): Promise<string[]> {
      const snapshot = await invoke<CoordinatorSnapshot>("get_project_coordinator", { projectId });
      return snapshot.workflows
        .filter(
          (workflow) =>
            workflow.kind === kind &&
            workflow.conversationId === conversation.id &&
            workflow.pending !== true &&
            !workflow.resourceId.startsWith("pending:"),
        )
        .map((workflow) => workflow.resourceId);
    },
    async pipeline(pipelineId: string): Promise<RoutingPipeline | undefined> {
      return pipelineSnapshot(
        await invoke<unknown>("get_build_pipeline", { pipelineId }).catch(() => null),
      );
    },
    async reviews(environmentId: string): Promise<RoutingReview[]> {
      return listOf<RoutingReview>(
        await invoke<unknown>("list_multi_review_workflows", { environmentId }).catch(() => []),
      );
    },
  };
}

/** What existed before a case, so the case's own tickets and workflows can be told apart. */
async function baseline(reads: ReturnType<typeof backendReads>) {
  const [tickets, pipelines, reviews, workers] = await Promise.all([
    reads.tickets(),
    reads.associated("build-pipeline"),
    reads.associated("multi-review"),
    reads.associated("environment"),
  ]);
  return {
    tickets: new Set(tickets.map((ticket) => ticket.id)),
    pipelines: new Set(pipelines),
    reviews: new Set(reviews),
    workers: new Set(workers),
  };
}

/** What a case added over its baseline. */
async function added(
  reads: ReturnType<typeof backendReads>,
  before: Awaited<ReturnType<typeof baseline>>,
) {
  const [tickets, pipelines, reviews, workers] = await Promise.all([
    reads.tickets(),
    reads.associated("build-pipeline"),
    reads.associated("multi-review"),
    reads.associated("environment"),
  ]);
  return {
    tickets: tickets.filter((ticket) => !before.tickets.has(ticket.id)),
    pipelines: pipelines.filter((id) => !before.pipelines.has(id)),
    reviews: reviews.filter((id) => !before.reviews.has(id)),
    workers: workers.filter((id) => !before.workers.has(id)),
  };
}

/**
 * The coordinator idle, with an empty queue and no mail waiting for it, for
 * `quietMs` in a row. A cancelled build or review, and a worker's report,
 * each wake the coordinator a little later; the next case must not start
 * until that wake has come and gone.
 */
async function settleQuiet(
  watch: Watch,
  coordinatorEnvironmentId: string,
  label: string,
  quietMs: number,
): Promise<void> {
  let quietSince: number | undefined;
  await watch.until(label, (observation) => {
    const waiting = observation.mail.some(
      (item) =>
        item.toEnvironmentId === coordinatorEnvironmentId &&
        (item.placement === "pending-inject" || item.placement === "inject-held"),
    );
    if (observation.coordinatorPhase === "error") {
      throw new Error(
        `the coordinator turn failed: ${watch.projection()?.turn.error ?? "no error text"}`,
      );
    }
    if (
      observation.coordinatorPhase !== "idle" ||
      observation.queueLength > 0 ||
      waiting ||
      observation.delegations.some((d) => d.state === "running" || !d.wokenAt)
    ) {
      quietSince = undefined;
      return false;
    }
    quietSince ??= observation.at;
    return observation.at - quietSince >= quietMs;
  });
}

/**
 * The routing scenario's backend orchestration, shared by the live spec and the
 * credential-free test that scripts the command transport. See
 * `coordinator-live-routing.ts` for what it qualifies.
 */
export async function runRoutingScenario(input: {
  coordinator: DelegationCoordinator;
  summary: CoordinatorLivePlatformSummary;
  cleanup: Array<() => Promise<unknown>>;
  token?: string;
  pollIntervalMs?: number;
  /** How long the coordinator must stay quiet between cases (default 20 s). */
  quietMs?: number;
  /** The cases to run, in order (default all four). */
  cases?: readonly RoutingCase[];
  /**
   * Progress lines, content-free. One per case edge keeps `test:logged`'s
   * no-output watchdog quiet: a fast provider's turns and quiet waits can each
   * end inside the observer's one-minute heartbeat, adding up to minutes of
   * silence.
   */
  log?: (line: string) => void;
}) {
  const { coordinator, summary, cleanup } = input;
  const { invoke, identity, projectId } = coordinator;
  const platform = identity.agent;
  const coordinatorEnvironmentId = identity.environmentId;
  const quietMs = input.quietMs ?? 20_000;
  const budgets = coordinatorLiveBudgets();
  const probe: RoutingProbe = { platform, token: input.token ?? randomBytes(6).toString("hex") };
  const reads = backendReads(coordinator);
  const cases = ROUTING_CASES.filter((name) => (input.cases ?? ROUTING_CASES).includes(name));

  // Cleanup runs last-first: live work is cancelled, then environments are
  // deleted, then the case's tickets.
  const ticketsBefore = new Set((await reads.tickets()).map((ticket) => ticket.id));
  cleanup.push(async () => {
    for (const ticket of await reads.tickets()) {
      if (!ticketsBefore.has(ticket.id)) await invoke("delete_kanban_task", { taskId: ticket.id });
    }
  });
  await removeLaunchedEnvironments(invoke, projectId, cleanup);

  const config = await invoke<{
    global: Record<string, unknown>;
    repositories: Record<string, { coordinatorOtherEnvironments?: boolean }>;
  }>("get_config");
  const previousAgentSettings = config.global.agentSettings;
  await invoke("update_global_config", {
    global: {
      ...config.global,
      agentSettings: routingAgentSettings(previousAgentSettings, platform),
    },
  });
  cleanup.push(async () => {
    const current = await invoke<{ global: Record<string, unknown> }>("get_config");
    await invoke("update_global_config", {
      global: { ...current.global, agentSettings: previousAgentSettings },
    });
  });
  cleanup.push(async () => {
    for (const pipelineId of await reads.associated("build-pipeline")) {
      const pipeline = await reads.pipeline(pipelineId);
      if (pipeline && !TERMINAL_PIPELINE_PHASES.has(pipeline.phase) && !pipeline.cancelledAt) {
        await invoke("cancel_build_pipeline", { pipelineId });
      }
    }
    // A review that already ended refuses the cancel; deleting its environment
    // is what cleans it up.
    for (const workflowId of await reads.associated("multi-review")) {
      await invoke("cancel_multi_review", { workflowId }).catch(() => undefined);
    }
  });

  const collected = createRoutingRows();
  const watch = createDelegationWatch(invoke, coordinator, summary, input.pollIntervalMs, {
    onProjection: (projection) => collected.observe(projection?.messages ?? []),
  });
  const checks: CoordinatorLiveCheck[] = [];
  const observed: Record<string, number> = {};
  const caseRows = () => collected.messages();
  const countCalls = (name: RoutingCase, rows: ReturnType<typeof caseRows>) => {
    for (const [tool, count] of Object.entries(workflowCallCounts(routingToolCalls(rows)))) {
      observed[`${name}:${tool}`] = count;
    }
  };
  const settle = (label: string) => settleQuiet(watch, coordinatorEnvironmentId, label, quietMs);

  async function buildCase(name: "build" | "delivery") {
    const before = await baseline(reads);
    const prompt = name === "build" ? routingBuildPrompt(probe) : routingDeliveryPrompt(probe);
    await coordinatorTurn(watch, coordinator, `the ${name} request`, prompt);
    const rows = caseRows();
    countCalls(name, rows);
    const fresh = await added(reads, before);
    const pipeline = fresh.pipelines[0] ? await reads.pipeline(fresh.pipelines[0]) : undefined;
    checks.push(
      ...evaluateRoutingBuild({
        prefix: name,
        messages: rows,
        newTickets: fresh.tickets,
        newPipelineIds: fresh.pipelines,
        ...(pipeline ? { pipeline } : {}),
      }),
    );
    return { fresh, pipeline };
  }

  const steps: Record<RoutingCase, () => Promise<void>> = {
    // 1. A specified change: ticket, then build. Cancelled once the call is judged.
    async build() {
      const { fresh } = await buildCase("build");
      for (const pipelineId of fresh.pipelines) {
        await invoke("cancel_build_pipeline", { pipelineId });
      }
      await settle("the coordinator after the build was cancelled");
    },

    // 2. A question that needs a run: a worker, and its report let through.
    async investigate() {
      const before = await baseline(reads);
      const prior = await watch.observe();
      const requestKey = (d: { environmentId: string; workerTabId: string; requestedAt: string }) =>
        JSON.stringify([d.environmentId, d.workerTabId, d.requestedAt]);
      const priorRequests = new Set(prior.delegations.map(requestKey));
      await coordinatorTurn(
        watch,
        coordinator,
        "the investigation request",
        routingInvestigatePrompt(),
      );
      const rows = caseRows();
      countCalls("investigate", rows);
      const fresh = await added(reads, before);
      const investigation = (await watch.observe()).delegations.filter(
        (d) => !priorRequests.has(requestKey(d)),
      );
      checks.push(
        ...evaluateRoutingInvestigate({
          messages: rows,
          newWorkers: fresh.workers.length,
          delegationRequests: investigation,
          newTickets: fresh.tickets.length,
          newPipelines: fresh.pipelines.length,
          newReviews: fresh.reviews.length,
        }),
      );
      for (const pipelineId of fresh.pipelines) {
        await invoke("cancel_build_pipeline", { pipelineId });
      }
      for (const workflowId of fresh.reviews) {
        await invoke("cancel_multi_review", { workflowId }).catch(() => undefined);
      }
      if (investigation.length > 0) {
        await watch.until("the investigating worker's report and wake", (observation) =>
          investigation.every((request) =>
            observation.delegations.some(
              (d) =>
                requestKey(d) === requestKey(request) &&
                d.state === "completed" &&
                d.wokenAt !== undefined &&
                observation.workerPhases?.[d.environmentId] === "idle",
            ),
          ),
        );
      }
      await settle("the coordinator after the investigation");
    },

    // 3. A review request: one Multi Review, its auto-actions off. Cancelled once judged.
    async review() {
      const previousOtherEnvironments =
        config.repositories[projectId]?.coordinatorOtherEnvironments;
      cleanup.push(() =>
        invoke("patch_repository_settings", {
          projectId,
          updates:
            previousOtherEnvironments === undefined
              ? {}
              : { coordinatorOtherEnvironments: previousOtherEnvironments },
          unset: previousOtherEnvironments === undefined ? ["coordinatorOtherEnvironments"] : [],
        }),
      );
      // The harness made this environment, so the coordinator needs the
      // project's opt-in before it may review it.
      await invoke("patch_repository_settings", {
        projectId,
        updates: { coordinatorOtherEnvironments: true },
      });
      const environment = await invoke<{ id: string }>("create_environment", {
        projectId,
        name: routingEnvironmentName(probe.token),
        environmentType: "local",
        networkAccessMode: "restricted",
      });
      await invoke("start_environment", { environmentId: environment.id });
      const details = await invoke<{
        name?: string;
        branch?: string;
        worktreePath?: string | null;
      }>("get_environment", { environmentId: environment.id });
      if (!details.worktreePath) throw new Error("the reviewed environment has no worktree");
      await writeFile(
        path.join(details.worktreePath, STATUS_REVIEWEE_FILE.path),
        STATUS_REVIEWEE_FILE.content,
      );
      const target: RoutingReviewTarget = {
        environmentId: environment.id,
        name: details.name ?? routingEnvironmentName(probe.token),
        branch: details.branch ?? routingEnvironmentName(probe.token),
      };

      const before = await baseline(reads);
      await coordinatorTurn(watch, coordinator, "the review request", routingReviewPrompt(target));
      const rows = caseRows();
      countCalls("review", rows);
      const fresh = await added(reads, before);
      const review = (await reads.reviews(target.environmentId)).find(
        (workflow) => workflow.id === fresh.reviews[0],
      );
      checks.push(
        ...evaluateRoutingReview({
          messages: rows,
          target,
          newReviewIds: fresh.reviews,
          ...(review ? { review } : {}),
          newTickets: fresh.tickets.length,
          newPipelines: fresh.pipelines.length,
        }),
      );
      for (const workflowId of fresh.reviews) {
        await invoke("cancel_multi_review", { workflowId });
      }
      for (const pipelineId of fresh.pipelines) {
        await invoke("cancel_build_pipeline", { pipelineId });
      }
      await settle("the coordinator after the review was cancelled");
    },

    // 4. Case 1 under `commit-only`, run to its end.
    async delivery() {
      const { fresh, pipeline } = await buildCase("delivery");
      if (!pipeline) throw new Error("the delivery request started no build pipeline");
      // Verify reads the live ticket's policy, minutes from now.
      await invoke("update_kanban_task", {
        taskId: pipeline.taskId,
        sections: { delivery: { policy: "commit-only" } },
      });
      for (const extra of fresh.pipelines.slice(1)) {
        await invoke("cancel_build_pipeline", { pipelineId: extra });
      }
      let ended: RoutingPipeline | undefined;
      await watch.until(
        "the commit-only build to finish",
        async () => {
          ended = await reads.pipeline(pipeline.id);
          if (ended?.phase === "paused") {
            throw new Error(`the build paused: ${(ended.error ?? "no reason").slice(0, 300)}`);
          }
          return (
            ended !== undefined &&
            (TERMINAL_PIPELINE_PHASES.has(ended.phase) || ended.cancelledAt !== undefined)
          );
        },
        budgets.build,
      );
      await settle("the coordinator after the build finished");
      checks.push(
        ...evaluateRoutingDeliveryOutcome({
          messages: caseRows(),
          ...(ended ? { pipeline: ended } : {}),
        }),
      );
    },
  };

  const log = input.log ?? ((line: string) => console.log(line));
  const progress = (text: string) => log(`[coordinator-live] ${platform}: routing ${text}`);
  let stopped: string | undefined;
  for (const name of cases) {
    if (stopped) {
      checks.push({ name: `${name}-finished`, passed: false, detail: `not run: ${stopped}` });
      continue;
    }
    const started = Date.now();
    progress(`case ${name} started`);
    try {
      await watch.observe();
      collected.begin();
      await steps[name]();
      checks.push({ name: `${name}-finished`, passed: true });
      progress(`case ${name} finished in ${Math.round((Date.now() - started) / 1_000)}s`);
    } catch (error) {
      checks.push({ name: `${name}-finished`, passed: false, detail: message(error) });
      progress(`case ${name} failed after ${Math.round((Date.now() - started) / 1_000)}s`);
      // A later case starts only from a quiet coordinator.
      try {
        await settle(`the coordinator after the ${name} case failed`);
      } catch (settleError) {
        stopped = `the coordinator did not settle after the ${name} case: ${message(settleError)}`;
      }
    }
  }

  checks.push(
    ...evaluateRoutingInteractions({
      escapedInteractions: watch.escaped(),
      workerInteractions: watch.workerEscaped(),
    }),
  );
  const mail = await watch.mailWithBodies();
  return { checks, observed, watch, mail, probe };
}
