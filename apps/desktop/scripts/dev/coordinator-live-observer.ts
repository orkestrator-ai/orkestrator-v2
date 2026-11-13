import type {
  AgentInteractionKind,
  AgentInteractionQuestionAnswer,
} from "@orkestrator/protocol/agent-interactions";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { CoordinatorSnapshot } from "@orkestrator/protocol/coordinator";
import {
  createTurnWatch,
  transcriptToolCalls,
  isApprovalKind,
  turnAnswerResolution,
  type CoordinatorLivePlatformSummary,
  type CoordinatorTurnProjection,
  type CoordinatorTranscriptMessage,
  type TurnAnswer,
  type ToolDetails,
} from "./coordinator-live.js";
import {
  orkestratorToolCalls,
  type DelegationMailMessage,
  type DelegationObservation,
  type DelegationRecord,
} from "./coordinator-live-delegation.js";
import { coordinatorLiveBudgets } from "./coordinator-live-budgets.js";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Projection = CoordinatorTurnProjection;
type SessionIdentity = { environmentId: string; agent: AgentPlatform; logicalSessionKey: string };
export interface DelegationCoordinator {
  invoke: Invoke;
  identity: SessionIdentity;
  conversation: { id: string; tabId: string };
  projectId: string;
}
const HEARTBEAT_MS = 60_000;
const MAX_TOOL_ERROR_CHARS = 500;

/** Cleanup errors are content-free, and never prevent later cleanup steps. */
export async function runCoordinatorCleanup(
  cleanup: Array<() => Promise<unknown>>,
  summary: CoordinatorLivePlatformSummary,
): Promise<void> {
  let failures = 0;
  for (const step of cleanup.toReversed()) {
    try {
      await step();
    } catch {
      failures += 1;
    }
  }
  if (failures > 0) {
    summary.verdict = "failed";
    summary.reason = `${summary.reason ? summary.reason + "; " : ""}${failures} cleanup steps failed`;
  }
}

/**
 * Stops and deletes every environment the case's coordinator launched, found
 * by being absent before the case started. Registered before the first turn,
 * so a failed case still removes its workers.
 */
export async function removeLaunchedEnvironments(
  invoke: Invoke,
  projectId: string,
  cleanup: Array<() => Promise<unknown>>,
): Promise<void> {
  const existing = new Set(
    (await invoke<Array<{ id: string }>>("get_environments", { projectId })).map(
      (environment) => environment.id,
    ),
  );
  cleanup.push(async () => {
    const failures: Error[] = [];
    for (const environment of await invoke<Array<{ id: string }>>("get_environments", {
      projectId,
    })) {
      if (existing.has(environment.id)) continue;
      await invoke("stop_environment", { environmentId: environment.id }).catch(() => undefined);
      try {
        await invoke("delete_environment", { environmentId: environment.id });
      } catch {
        failures.push(new Error("A launched worker could not be deleted"));
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "Worker cleanup failed");
  });
}

type MailboxPage = { messages?: DelegationMailMessage[] };
type EnvironmentRow = { id: string; name?: string };

/**
 * Watches one coordinator and every worker it launched while a delegation
 * scenario runs. Each `observe()` reads the coordinator's turn, the workers'
 * turns, the coordinator's delegations, every family mailbox and the
 * coordinator's prompt queue, denies (or cancels) any interaction that
 * reached the harness and records its kind, and appends the observation.
 *
 * `holdWorkerInteractions` names workers whose interactions the harness
 * leaves pending instead: the status scenario needs a worker that stays
 * waiting on an approval. They are recorded apart (`held`) and answered only
 * by `release`.
 *
 * `worker` is the backend that owns the workers and their project there,
 * when that is not the coordinator's own: a worker on a connected node keeps
 * its session, its interactions, its mailbox and its environment row on that
 * node. Every worker read and answer goes there; the coordinator's own turn,
 * delegations, mailbox and queue stay on `invoke`. `workerObserved` says
 * whether a worker's session was ever read, so a scenario can refuse to
 * claim "no interaction escaped" for a worker it never saw.
 */
export function createDelegationWatch(
  invoke: Invoke,
  coordinator: DelegationCoordinator,
  summary: CoordinatorLivePlatformSummary,
  pollIntervalMs = 2_000,
  options: {
    holdWorkerInteractions?: (environmentId: string) => boolean;
    onProjection?: (projection: Projection | null) => void;
    worker?: { invoke: Invoke; projectId: string };
    /**
     * Answers a question the coordinator asks, for a scenario that expects one
     * (`ask`); see `createTurnWatch`. Without it every question escapes.
     */
    answerCoordinatorQuestion?: (
      request: NonNullable<Projection["interactions"]>[number],
    ) => AgentInteractionQuestionAnswer[] | undefined;
  } = {},
) {
  const { identity, conversation, projectId } = coordinator;
  const workerInvoke = options.worker?.invoke ?? invoke;
  const workerProjectId = options.worker?.projectId ?? projectId;
  /** Workers whose own session was read at least once. */
  const observedWorkers = new Set<string>();
  const coordinatorMailbox = { environmentId: identity.environmentId, tabId: conversation.tabId };
  const queueKey = `${identity.agent}\0${identity.logicalSessionKey}`;
  const observations: DelegationObservation[] = [];
  const coordinatorTurn = createTurnWatch(
    options.answerCoordinatorQuestion ? { answerQuestion: options.answerCoordinatorQuestion } : {},
  );
  const workerTurns = new Map<string, ReturnType<typeof createTurnWatch>>();
  const workerPhases = new Map<string, string>();
  /** A worker turn that failed, by environment: the scenario cannot go on. */
  const workerErrors = new Map<string, string>();
  const names = new Map<string, string>();
  const workerTabs = new Map<string, string>();
  /** Held interactions by worker, then by interaction id. */
  const held = new Map<
    string,
    Map<
      string,
      {
        kind: AgentInteractionKind;
        sessionId: string;
        createdAt: number;
        seenAt: number;
        releasedAt?: number;
      }
    >
  >();
  let projection: Projection | null = null;

  const workerIdentity = (environmentId: string): SessionIdentity => ({
    environmentId,
    agent: identity.agent,
    logicalSessionKey: `env-${environmentId}:${workerTabs.get(environmentId) ?? "startup-agent"}`,
  });
  const answer = async (target: SessionIdentity, answers: TurnAnswer[], via: Invoke = invoke) => {
    for (const item of answers) {
      await via("resolve_native_agent_interaction", {
        ...target,
        interactionId: item.interactionId,
        resolution: turnAnswerResolution(item),
      });
    }
  };
  const mailbox = async (environmentId: string, tabId: string, via: Invoke = invoke) =>
    (
      await via<MailboxPage>("get_agent_mail_mailbox", {
        environmentId,
        tabId,
        limit: 200,
      }).catch(() => ({ messages: [] }) as MailboxPage)
    ).messages ?? [];

  const watch = {
    observations,
    coordinatorMailbox,
    /** Environment ids of the workers this conversation launched, in launch order. */
    workers: [] as string[],
    projection: () => projection,
    workerName: (environmentId: string) => names.get(environmentId),
    workerPhase: (environmentId: string) => workerPhases.get(environmentId) ?? "unknown",
    escaped: () => coordinatorTurn.escapedInteractions(),
    /** Coordinator questions answered through `answerCoordinatorQuestion`. */
    answeredQuestions: () => coordinatorTurn.answeredQuestions(),
    workerEscaped: () => [...workerTurns.values()].flatMap((turn) => turn.escapedInteractions()),
    /** The worker's own session was read at least once. */
    workerObserved: (environmentId: string) => observedWorkers.has(environmentId),
    /** Interactions held for a worker named by `holdWorkerInteractions`, in arrival order. */
    held: (environmentId: string) =>
      [...(held.get(environmentId)?.values() ?? [])].map(
        ({ kind, createdAt, seenAt, releasedAt }) => ({
          kind,
          createdAt,
          seenAt,
          ...(releasedAt === undefined ? {} : { releasedAt }),
        }),
      ),
    /** Deny (or cancel) every interaction still held for a worker. */
    async release(environmentId: string): Promise<void> {
      const pending = held.get(environmentId);
      if (!pending) return;
      const failures: unknown[] = [];
      for (const [interactionId, request] of pending) {
        if (request.releasedAt !== undefined) continue;
        try {
          await answer(
            workerIdentity(environmentId),
            [
              {
                interactionId,
                sessionId: request.sessionId,
                action: isApprovalKind(request.kind) ? "deny" : "cancel",
              },
            ],
            workerInvoke,
          );
          request.releasedAt = Date.now();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0)
        throw new AggregateError(failures, "Held interaction release failed");
    },
    async observe(): Promise<DelegationObservation> {
      // Read coordinator mail before the confirming delegation snapshot. A
      // worker can finish and have mail injected between independent reads;
      // snapshot-first would pair an old running state with new injected mail.
      // The remaining independent reads run together to keep samples quick.
      const coordinatorMail = await mailbox(
        coordinatorMailbox.environmentId,
        coordinatorMailbox.tabId,
      );
      const [nextProjection, snapshot, queue] = await Promise.all([
        invoke<Projection | null>("get_native_agent_projection", {
          ...identity,
          messageLimit: 200,
        }),
        invoke<CoordinatorSnapshot>("get_project_coordinator", { projectId }),
        invoke<{ messages?: unknown[] } | null>("get_prompt_queue", { queueKey }).catch(() => null),
      ]);
      projection = nextProjection;
      options.onProjection?.(projection);
      const { answers } = coordinatorTurn.observe(projection);
      await answer(identity, answers);

      const associations = snapshot.workflows.filter(
        (workflow) =>
          workflow.kind === "environment" && workflow.conversationId === conversation.id,
      );
      for (const association of associations) {
        if (association.delegation)
          workerTabs.set(association.resourceId, association.delegation.workerTabId);
        if (!watch.workers.includes(association.resourceId))
          watch.workers.push(association.resourceId);
      }
      if (watch.workers.some((id) => !names.has(id))) {
        for (const environment of await workerInvoke<EnvironmentRow[]>("get_environments", {
          projectId: workerProjectId,
        })) {
          if (environment.name) names.set(environment.id, environment.name);
        }
      }
      const delegations: DelegationRecord[] = associations.flatMap((association) =>
        association.delegation
          ? [{ environmentId: association.resourceId, ...association.delegation }]
          : [],
      );

      const workerReads = await Promise.all(
        watch.workers.map(async (worker) => {
          const target = workerIdentity(worker);
          const [workerMail, workerProjection] = await Promise.all([
            mailbox(worker, workerTabs.get(worker) ?? "startup-agent", workerInvoke),
            workerInvoke<Projection | null>("get_native_agent_projection", {
              ...target,
              messageLimit: 20,
            }).catch(() => null),
          ]);
          return { worker, target, workerMail, workerProjection };
        }),
      );
      const mail = [...coordinatorMail];
      const phases: Record<string, string> = {};
      for (const { worker, target, workerMail, workerProjection } of workerReads) {
        mail.push(...workerMail);
        if (workerProjection) {
          observedWorkers.add(worker);
          workerPhases.set(worker, workerProjection.turn.phase);
          phases[worker] = workerProjection.turn.phase;
          if (workerProjection.turn.phase === "error") {
            workerErrors.set(
              worker,
              (workerProjection.turn.error ?? "no error text").slice(0, 300),
            );
          }
        }
        if (options.holdWorkerInteractions?.(worker)) {
          const pending = held.get(worker) ?? new Map();
          held.set(worker, pending);
          for (const request of workerProjection?.interactions ?? []) {
            if (request.state !== "pending" || pending.has(request.id)) continue;
            pending.set(request.id, {
              kind: request.kind,
              sessionId: request.sessionId,
              createdAt: request.createdAt,
              seenAt: Date.now(),
            });
          }
          continue;
        }
        const turn = workerTurns.get(worker) ?? createTurnWatch();
        workerTurns.set(worker, turn);
        await answer(target, turn.observe(workerProjection).answers, workerInvoke);
      }
      const observation: DelegationObservation = {
        at: Date.now(),
        coordinatorPhase: projection?.turn.phase ?? "idle",
        ...(projection?.contextUsage?.turns
          ? { coordinatorTurnIds: projection.contextUsage.turns.map((turn) => turn.turnId) }
          : {}),
        queueLength: queue?.messages?.length ?? 0,
        workerPhases: phases,
        delegations,
        mail: mail.map(({ body: _body, ...summaryOnly }) => summaryOnly),
      };
      observations.push(observation);
      const escaped = [...watch.escaped(), ...watch.workerEscaped()];
      if (escaped.length > 0) summary.escapedInteractions = escaped;
      return observation;
    },
    /**
     * Observe until `done` holds, failing with `label` at the deadline. Prints
     * a progress line every minute so `test:logged`'s watchdog stays quiet.
     */
    async until(
      label: string,
      done: (observation: DelegationObservation) => boolean | Promise<boolean>,
      timeoutMs = coordinatorLiveBudgets().step,
    ): Promise<DelegationObservation> {
      const started = Date.now();
      let nextHeartbeat = started + HEARTBEAT_MS;
      for (;;) {
        const observation = await watch.observe();
        if (await done(observation)) return observation;
        const [failedWorker, workerError] = [...workerErrors][0] ?? [];
        if (failedWorker) {
          throw new Error(
            `${identity.agent}: worker ${watch.workerName(failedWorker) ?? failedWorker} failed its turn while waiting for ${label}: ${workerError}`,
          );
        }
        const now = Date.now();
        if (now - started >= timeoutMs) {
          throw new Error(
            `${identity.agent}: timed out after ${Math.round((now - started) / 1_000)}s waiting for ${label} (coordinator ${observation.coordinatorPhase}, workers ${watch.workers.map((id) => watch.workerPhase(id)).join("/") || "none"})`,
          );
        }
        if (now >= nextHeartbeat) {
          console.log(
            `[coordinator-live] ${identity.agent}: waiting for ${label} for ${Math.round((now - started) / 1_000)}s (coordinator ${observation.coordinatorPhase}, ${watch.workers.length} workers)`,
          );
          nextHeartbeat = now + HEARTBEAT_MS;
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    },
    /** The coordinator idle for two reads in a row, after it was seen working. */
    async coordinatorSettled(label: string, timeoutMs?: number): Promise<void> {
      let idleReads = 0;
      await watch.until(
        label,
        (observation) => {
          idleReads = observation.coordinatorPhase === "idle" ? idleReads + 1 : 0;
          if (observation.coordinatorPhase === "error") {
            throw new Error(
              `the ${identity.agent} coordinator turn failed: ${projection?.turn.error ?? "no error text"}`,
            );
          }
          return idleReads >= 2 && observation.queueLength === 0;
        },
        timeoutMs,
      );
    },
    /** Full mail state with bodies, which the evaluation reads and never records. */
    async mailWithBodies(): Promise<DelegationMailMessage[]> {
      const latest = observations.at(-1)?.mail ?? [];
      return Promise.all(
        latest.map(async (message) => {
          // A worker's mailbox lives on the node that owns the worker.
          const via = watch.workers.includes(message.toEnvironmentId) ? workerInvoke : invoke;
          const full = await via<{ body?: string } | null>("get_agent_mail_message", {
            environmentId: message.toEnvironmentId,
            tabId: message.toTabId,
            messageId: message.id,
          }).catch(() => null);
          return typeof full?.body === "string" ? { ...message, body: full.body } : message;
        }),
      );
    },
    /** Tool rows' output, fetched from behind each row's detail reference. */
    toolOutputs: (tool: string, messages: readonly CoordinatorTranscriptMessage[]) =>
      readToolOutputs(invoke, identity, tool, messages),
  };
  return watch;
}

/**
 * The output of every row of one Orkestrator tool in `messages`, fetched from
 * behind each row's detail reference when the row carries none. A failed call
 * reads as `{"isError":true,"error":…}`, its message bounded: evaluations read
 * it, and a check detail may quote it.
 */
export async function readToolOutputs(
  invoke: Invoke,
  identity: SessionIdentity,
  tool: string,
  messages: readonly CoordinatorTranscriptMessage[],
): Promise<string[]> {
  const outputs: string[] = [];
  const visit = async (value: unknown, depth: number): Promise<void> => {
    if (depth > 8) return;
    if (Array.isArray(value)) {
      for (const item of value) await visit(item, depth + 1);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (
      typeof record.toolName === "string" &&
      orkestratorToolCalls([{ name: record.toolName, args: "", state: "unknown" }], tool).length > 0
    ) {
      const failed = (error: string) =>
        JSON.stringify({ isError: true, error: error.slice(0, MAX_TOOL_ERROR_CHARS) });
      let text = typeof record.toolOutput === "string" ? record.toolOutput : "";
      if (!text && typeof record.toolError === "string" && record.toolError)
        text = failed(record.toolError);
      if (!text && typeof record.detailRef === "string") {
        const details = await invoke<ToolDetails | null>("get_native_agent_tool_details", {
          ...identity,
          detailRef: record.detailRef,
        }).catch(() => null);
        text = details?.toolError ? failed(details.toolError) : (details?.toolOutput ?? "");
      }
      outputs.push(text);
    }
    for (const field of ["childTools", "subagentActions"]) await visit(record[field], depth + 1);
  };
  for (const message of messages) await visit(message.parts, 0);
  return outputs;
}

/**
 * Settle a fresh turn, safely denying/cancelling escaped interactions and
 * retaining them for qualification. Report progress during long provider turns
 * so the logged-command watchdog can distinguish waiting from a hung harness.
 */
export async function settleCoordinatorTurn(
  invoke: Invoke,
  identity: SessionIdentity,
  summary: CoordinatorLivePlatformSummary,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<{ projection: Projection; escaped: AgentInteractionKind[] }> {
  const timeoutMs = options.timeoutMs ?? coordinatorLiveBudgets().turn;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const started = Date.now();
  const deadline = started + timeoutMs;
  let nextHeartbeat = started + HEARTBEAT_MS;
  const watch = createTurnWatch();
  for (;;) {
    const projection = await invoke<Projection | null>("get_native_agent_projection", {
      ...identity,
      messageLimit: 200,
    });
    const { settled, answers } = watch.observe(projection);
    for (const answer of answers) {
      await invoke("resolve_native_agent_interaction", {
        ...identity,
        interactionId: answer.interactionId,
        resolution: turnAnswerResolution(answer),
      });
    }
    if (answers.length > 0) summary.escapedInteractions = watch.escapedInteractions();
    if (projection && settled) {
      return { projection, escaped: watch.escapedInteractions() };
    }
    const phase = projection?.turn.phase ?? "idle";
    const now = Date.now();
    if (now >= deadline) {
      throw new Error(
        `the ${identity.agent} coordinator turn did not finish within ${timeoutMs / 1_000}s (phase ${phase})`,
      );
    }
    if (now >= nextHeartbeat) {
      console.log(
        `[coordinator-live] ${identity.agent}: turn ${phase} for ${Math.round((now - started) / 1_000)}s, ${transcriptToolCalls(projection?.messages ?? []).length} tool calls so far`,
      );
      nextHeartbeat = now + HEARTBEAT_MS;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}
