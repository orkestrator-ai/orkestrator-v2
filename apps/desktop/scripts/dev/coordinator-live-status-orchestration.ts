import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  transcriptAssistantText,
  type CoordinatorLivePlatformSummary,
  type CoordinatorLiveCheck,
} from "./coordinator-live.js";
import {
  createDelegationWatch,
  removeLaunchedEnvironments,
  settleCoordinatorTurn,
  type DelegationCoordinator,
} from "./coordinator-live-observer.js";
import { coordinatorTurn } from "./coordinator-live-orchestration.js";
import { coordinatorLiveBudgets } from "./coordinator-live-budgets.js";
import type { DelegationMailMessage } from "./coordinator-live-delegation.js";
import {
  STATUS_REVIEWEE_FILE,
  STATUS_REVIEW_DONE_MARKER,
  STATUS_WAITER_DONE_MARKER,
  STATUS_WAITING_MARKER,
  STATUS_WAITING_STATE,
  approvalWaitApplies,
  evaluateStatusReview,
  evaluateStatusWaiting,
  revieweeEnvironmentInput,
  statusReviewAgentSettings,
  statusReviewPrompt,
  statusWaitingPrompt,
  waiterEnvironmentInput,
  type StatusProbe,
} from "./coordinator-live-status.js";

type Invoke = DelegationCoordinator["invoke"];
type SessionIdentity = DelegationCoordinator["identity"];

/**
 * Waits for one of `identity`'s turns to settle (see {@link settleCoordinatorTurn}) and
 * fails on a turn error or any interaction requiring harness intervention.
 */
export async function startupTurn(
  invoke: Invoke,
  identity: SessionIdentity,
  summary: CoordinatorLivePlatformSummary,
  label: string,
  pollIntervalMs?: number,
): Promise<void> {
  const { projection, escaped } = await settleCoordinatorTurn(invoke, identity, summary, {
    pollIntervalMs,
  });
  if (escaped.length > 0)
    throw new Error(`${label} required harness intervention: ${escaped.join(", ")}`);
  if (projection.turn.phase === "error") {
    throw new Error(`${label} failed: ${projection.turn.error ?? "no error text"}`);
  }
}

/** Whether the coordinator's assistant text after `fromRow` carries `line`. */
function saidAfter(
  watch: ReturnType<typeof createDelegationWatch>,
  fromRow: number,
  line: string,
): boolean {
  return transcriptAssistantText((watch.projection()?.messages ?? []).slice(fromRow)).includes(
    line,
  );
}

/** Backend status orchestration shared by the live spec and scripted transport tests. */
export async function runStatusScenario(input: {
  coordinator: DelegationCoordinator;
  token?: string;
  pollIntervalMs?: number;
  summary: CoordinatorLivePlatformSummary;
  cleanup: Array<() => Promise<unknown>>;
}) {
  const { coordinator, summary, cleanup } = input;
  const { invoke, identity, projectId } = coordinator;
  const platform = identity.agent;
  const coordinatorEnvironmentId = identity.environmentId;
  // Removes the two environments made here too: neither existed before.
  await removeLaunchedEnvironments(invoke, projectId, cleanup);
  const token = input.token ?? randomBytes(6).toString("hex");
  const budgets = coordinatorLiveBudgets();

  // Saved Multi Review defaults on this platform, as the button would use.
  const config = await invoke<{ global: Record<string, unknown> }>("get_config");
  const previousAgentSettings = config.global.agentSettings;
  await invoke("update_global_config", {
    global: {
      ...config.global,
      agentSettings: statusReviewAgentSettings(previousAgentSettings, platform),
    },
  });
  cleanup.push(async () => {
    const current = await invoke<{ global: Record<string, unknown> }>("get_config");
    await invoke("update_global_config", {
      global: { ...current.global, agentSettings: previousAgentSettings },
    });
  });

  // The environment under review: a change with one real defect.
  const reviewee = await invoke<{ id: string }>(
    "create_environment",
    revieweeEnvironmentInput({ projectId, token }),
  );
  await invoke("start_environment", { environmentId: reviewee.id });
  const revieweeWorktree = (
    await invoke<{ worktreePath?: string | null }>("get_environment", {
      environmentId: reviewee.id,
    })
  ).worktreePath;
  if (!revieweeWorktree) throw new Error("the reviewed environment has no worktree");
  await writeFile(
    path.join(revieweeWorktree, STATUS_REVIEWEE_FILE.path),
    STATUS_REVIEWEE_FILE.content,
  );

  // The worker held on an approval: started and idle before it is delegated to.
  const holdsApproval = approvalWaitApplies(platform);
  const outsideDirectory = await mkdtemp(path.join(tmpdir(), "coordinator-live-status-"));
  cleanup.push(() => rm(outsideDirectory, { recursive: true, force: true }));
  let waiterEnvironmentId = "";
  if (holdsApproval) {
    const waiter = await invoke<{ id: string }>(
      "create_environment",
      waiterEnvironmentInput({ projectId, token, platform }),
    );
    await invoke("start_environment", { environmentId: waiter.id });
    waiterEnvironmentId = waiter.id;
    await startupTurn(
      invoke,
      {
        environmentId: waiter.id,
        agent: platform,
        logicalSessionKey: `env-${waiter.id}:startup-agent`,
      },
      summary,
      "the waiting worker's startup turn",
      input.pollIntervalMs,
    );
  }
  const probe: StatusProbe = {
    platform,
    token,
    revieweeEnvironmentId: reviewee.id,
    waiterEnvironmentId,
    waiterTabId: "startup-agent",
    outsidePath: path.join(outsideDirectory, "approval-probe.txt"),
  };
  const watch = createDelegationWatch(invoke, coordinator, summary, input.pollIntervalMs, {
    holdWorkerInteractions: (environmentId) => environmentId === waiterEnvironmentId,
  });
  const toCoordinator = (message: DelegationMailMessage) =>
    message.toEnvironmentId === coordinatorEnvironmentId && message.from.kind === "system";
  const failOnCoordinatorError = (phase: string) => {
    if (phase === "error") {
      throw new Error(
        `the ${platform} coordinator turn failed: ${watch.projection()?.turn.error ?? "no error text"}`,
      );
    }
  };

  // Review part.
  let reviewFinished: string | undefined;
  let reviewRowsBefore = watch.projection()?.messages.length ?? 0;
  try {
    reviewRowsBefore = (
      await coordinatorTurn(watch, coordinator, "the review launch turn", statusReviewPrompt(probe))
    ).rowsBefore;
    let idleReads = 0;
    await watch.until(
      "the Multi Review's fix-done wake",
      (observation) => {
        failOnCoordinatorError(observation.coordinatorPhase);
        const notices = observation.mail.filter(
          (message) =>
            toCoordinator(message) &&
            message.notice?.resource?.kind === "multi-review" &&
            message.notice.resource.environmentId === reviewee.id,
        );
        const ended = notices.find((message) =>
          ["failed", "cancelled", "fix-failed"].includes(message.notice?.state ?? ""),
        );
        if (ended) throw new Error(`the Multi Review reported ${ended.notice?.state}`);
        idleReads = observation.coordinatorPhase === "idle" ? idleReads + 1 : 0;
        const fixDone = notices.some(
          (message) => message.notice?.state === "fix-done" && message.placement === "injected",
        );
        return (
          fixDone &&
          saidAfter(watch, reviewRowsBefore, `${STATUS_REVIEW_DONE_MARKER} ${token}`) &&
          idleReads >= 2 &&
          observation.queueLength === 0
        );
      },
      budgets.review,
    );
  } catch (error) {
    reviewFinished = error instanceof Error ? error.message.slice(0, 500) : String(error);
  }
  const reviewMessages = (watch.projection()?.messages ?? []).slice(reviewRowsBefore);
  const reviewLaunches = await watch.toolOutputs("launch_multi_review", reviewMessages);
  const reviewEscaped = watch.escaped();
  const checks: CoordinatorLiveCheck[] = [
    {
      name: "review-finished",
      passed: reviewFinished === undefined,
      ...(reviewFinished ? { detail: reviewFinished } : {}),
    },
    ...evaluateStatusReview({
      probe,
      coordinatorEnvironmentId,
      messages: reviewMessages,
      launchResults: reviewLaunches,
      mail: watch.observations.at(-1)?.mail ?? [],
      escapedInteractions: reviewEscaped,
    }),
  ];

  // Approval part.
  if (holdsApproval) {
    let waitingFinished: string | undefined;
    let waitingRowsBefore = watch.projection()?.messages.length ?? 0;
    try {
      waitingRowsBefore = (
        await coordinatorTurn(
          watch,
          coordinator,
          "the approval delegation turn",
          statusWaitingPrompt(probe),
        )
      ).rowsBefore;
      await watch.until(
        "the worker's approval to reach the harness",
        () => watch.held(waiterEnvironmentId).length > 0,
      );
      let idleReads = 0;
      await watch.until("the waiting wake", (observation) => {
        failOnCoordinatorError(observation.coordinatorPhase);
        idleReads = observation.coordinatorPhase === "idle" ? idleReads + 1 : 0;
        const waiting = observation.mail.some(
          (message) =>
            toCoordinator(message) &&
            message.notice?.resource?.environmentId === waiterEnvironmentId &&
            message.notice.state === STATUS_WAITING_STATE &&
            message.placement === "injected",
        );
        return (
          waiting &&
          saidAfter(watch, waitingRowsBefore, `${STATUS_WAITING_MARKER} ${token}`) &&
          idleReads >= 2 &&
          observation.queueLength === 0
        );
      });
      await watch.release(waiterEnvironmentId);
      idleReads = 0;
      await watch.until("the waiting worker's report", (observation) => {
        failOnCoordinatorError(observation.coordinatorPhase);
        idleReads = observation.coordinatorPhase === "idle" ? idleReads + 1 : 0;
        return (
          saidAfter(watch, waitingRowsBefore, `${STATUS_WAITER_DONE_MARKER} ${token}`) &&
          idleReads >= 2 &&
          observation.queueLength === 0
        );
      });
    } catch (error) {
      waitingFinished = error instanceof Error ? error.message.slice(0, 500) : String(error);
      await watch.release(waiterEnvironmentId).catch(() => undefined);
    }
    checks.push(
      {
        name: "waiting-finished",
        passed: waitingFinished === undefined,
        ...(waitingFinished ? { detail: waitingFinished } : {}),
      },
      ...evaluateStatusWaiting({
        probe,
        coordinatorEnvironmentId,
        messages: (watch.projection()?.messages ?? []).slice(waitingRowsBefore),
        mail: watch.observations.at(-1)?.mail ?? [],
        held: watch.held(waiterEnvironmentId),
        escapedInteractions: watch.escaped().slice(reviewEscaped.length),
        workerInteractions: watch.workerEscaped(),
      }),
    );
  }

  return { checks, watch, holdsApproval, waiterEnvironmentId, probe };
}
