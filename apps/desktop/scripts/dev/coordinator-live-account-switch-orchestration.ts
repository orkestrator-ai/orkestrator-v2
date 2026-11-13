import { randomBytes } from "node:crypto";
import type { AgentAccountPlatform } from "@orkestrator/protocol/agent-accounts";
import {
  transcriptToolCalls,
  type CoordinatorLivePlatformSummary,
  type CoordinatorTranscriptMessage,
} from "./coordinator-live.js";
import {
  ACCOUNT_SWITCH_PHASES,
  accountSwitchAccountLabel,
  accountSwitchPrompt,
  accountSwitchWorkerName,
  evaluateAccountSwitchScenario,
  scheduleOutcome,
  SEEDED_USAGE_LIMIT_ERROR,
  switchRequestsFor,
  type AccountSwitchPhase,
  type AccountSwitchPhaseEvidence,
  type AccountSwitchProbe,
  type SwitchRequestRecord,
} from "./coordinator-live-account-switch.js";
import {
  createDelegationWatch,
  removeLaunchedEnvironments,
  type DelegationCoordinator,
} from "./coordinator-live-observer.js";
import { coordinatorTurn } from "./coordinator-live-orchestration.js";
import { startupTurn } from "./coordinator-live-status-orchestration.js";

type SessionIdentity = DelegationCoordinator["identity"];

/** The failed turn outcome the harness appends to the worker's session. */
export interface SeededTurnOutcome {
  requestId: string;
  outcome: "failed";
  error: string;
  failureKind: "usage-limit";
  observedAt: string;
}

/**
 * What the profile has to be given out of band, with its own undo pushed to
 * `cleanup`. The live spec writes the profile's account directory and store
 * (`e2e/agent-testing/backend-store.ts`); the scripted test fakes both.
 */
export interface AccountSwitchFixtures {
  /** One more signed-in fixture account for `platform`; never the active one. */
  stageAccount(platform: AgentAccountPlatform, label: string): Promise<{ accountId: string }>;
  /** Appends `outcome` as the session's latest turn outcome. */
  seedTurnOutcome(identity: SessionIdentity, outcome: SeededTurnOutcome): Promise<void>;
}

/**
 * The account-switch scenario's backend orchestration, shared by the live
 * spec and the credential-free test that scripts the command transport. See
 * `coordinator-live-account-switch.ts` for what it qualifies.
 *
 * The caller has turned on experimental scheduling (the schedule tools are
 * offered only then) and checked `accountSwitchApplies`.
 */
export async function runAccountSwitchScenario(input: {
  coordinator: DelegationCoordinator;
  summary: CoordinatorLivePlatformSummary;
  cleanup: Array<() => Promise<unknown>>;
  fixtures: AccountSwitchFixtures;
  token?: string;
  /** `create_schedule`'s `at`; default `+1m`. */
  at?: string;
  pollIntervalMs?: number;
}) {
  const { coordinator, summary, cleanup, fixtures } = input;
  const { invoke, identity, projectId } = coordinator;
  const platform = identity.agent as AgentAccountPlatform;
  const token = input.token ?? randomBytes(6).toString("hex");
  await removeLaunchedEnvironments(invoke, projectId, cleanup);

  const activeAccount = async () =>
    (await invoke<{ active?: Record<string, string> }>("list_agent_accounts", {})).active?.[
      platform
    ];
  const switchRequests = async () =>
    (await invoke<SwitchRequestRecord[]>("list_node_action_requests", {}).catch(() => [])) ?? [];

  let probe: AccountSwitchProbe | undefined;
  let finished: string | undefined;
  const phases: AccountSwitchPhaseEvidence[] = [];
  const watch = createDelegationWatch(invoke, coordinator, summary, input.pollIntervalMs);
  try {
    // The limited worker: a real tab with one finished turn, then the seeded
    // failure as its latest outcome, as a provider's limit would leave it.
    const worker = await invoke<{ id: string }>("create_environment", {
      projectId,
      name: accountSwitchWorkerName(token),
      environmentType: "local",
      networkAccessMode: "restricted",
      initialPrompt:
        "Reply with the single word ready and end your turn. Do not use any tools and do not send any messages.",
      agentSettings: {
        defaultAgent: platform,
        platforms: { [platform]: { mode: "native" } },
      },
      pendingAgentLaunch: true,
      initialAgentPlatform: platform,
      initialConversationMode: "build",
    });
    await invoke("start_environment", { environmentId: worker.id });
    const workerIdentity: SessionIdentity = {
      environmentId: worker.id,
      agent: platform,
      logicalSessionKey: `env-${worker.id}:startup-agent`,
    };
    await startupTurn(
      invoke,
      workerIdentity,
      summary,
      "the limited worker's startup turn",
      input.pollIntervalMs,
    );
    await fixtures.seedTurnOutcome(workerIdentity, {
      requestId: `account-switch-${token}`,
      outcome: "failed",
      error: SEEDED_USAGE_LIMIT_ERROR,
      failureKind: "usage-limit",
      observedAt: new Date().toISOString(),
    });
    const { accountId } = await fixtures.stageAccount(platform, accountSwitchAccountLabel(token));
    probe = { platform, token, accountId, workerEnvironmentId: worker.id, at: input.at ?? "+1m" };

    // A phase that throws keeps the evidence it gathered; the next does not run.
    for (const phase of ACCOUNT_SWITCH_PHASES) await runPhase(phase, probe);
  } catch (error) {
    finished = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
  }

  async function runPhase(phase: AccountSwitchPhase, probe: AccountSwitchProbe): Promise<void> {
    const activeBefore = await activeAccount();
    const evidence: AccountSwitchPhaseEvidence = {
      phase,
      setCalls: [],
      wakeCalls: [],
      scheduleResults: [],
      limitsResults: [],
      listResults: [],
      switchResults: [],
      observations: [],
      mail: [],
      requests: [],
      ...(activeBefore ? { activeBefore } : {}),
    };
    phases.push(evidence);
    const rows = (from: number, to?: number): CoordinatorTranscriptMessage[] =>
      (watch.projection()?.messages ?? []).slice(from, to);
    let setEnd = 0;
    let firstObservation = watch.observations.length;
    const pendingIds = new Set<string>();
    try {
      const set = await coordinatorTurn(
        watch,
        coordinator,
        `the ${phase} phase's set turn`,
        accountSwitchPrompt(probe, phase),
      );
      evidence.setEndedAt = set.endedAt;
      setEnd = watch.projection()?.messages.length ?? set.rowsBefore;
      firstObservation = watch.observations.length - 1;
      evidence.setCalls = transcriptToolCalls(rows(set.rowsBefore, setEnd));
      evidence.scheduleResults = await watch.toolOutputs(
        "create_schedule",
        rows(set.rowsBefore, setEnd),
      );
      const scheduleId = evidence.scheduleResults
        .map(scheduleOutcome)
        .find((outcome) => outcome.scheduleId)?.scheduleId;
      if (!scheduleId) throw new Error(`the ${phase} phase set no self-timer`);
      cleanup.push(() => invoke("delete_scheduled_job", { scheduleId }).catch(() => undefined));

      // The timer fires, the coordinator is woken and acts; then the outcome.
      let idleReads = 0;
      await watch.until(
        phase === "granted"
          ? "the switch under the timer's permission"
          : "the switch request the user approves",
        async (observation) => {
          const requests = switchRequestsFor(await switchRequests(), probe);
          for (const request of requests)
            if (request.state === "pending") pendingIds.add(request.requestId);
          const done =
            phase === "granted"
              ? requests.some((request) => request.state === "executed")
              : requests.some((request) => request.state === "pending");
          idleReads = done && observation.coordinatorPhase === "idle" ? idleReads + 1 : 0;
          return idleReads >= 2 && observation.queueLength === 0;
        },
      );
      if (phase === "request") {
        for (const requestId of pendingIds) {
          await invoke("resolve_node_action_request", { requestId, decision: "reject" });
        }
        evidence.rejected = pendingIds.size > 0;
        // The rejection is mailed back and wakes the coordinator once more.
        await watch.coordinatorSettled("the coordinator after the rejected request");
      }
    } finally {
      evidence.pendingSeen = pendingIds.size;
      const wakeRows = rows(setEnd);
      evidence.wakeCalls = transcriptToolCalls(wakeRows);
      evidence.limitsResults = await watch.toolOutputs("get_usage_limits", wakeRows);
      evidence.listResults = await watch.toolOutputs("list_provider_accounts", wakeRows);
      evidence.switchResults = await watch.toolOutputs("switch_provider_account", wakeRows);
      evidence.observations = watch.observations.slice(Math.max(0, firstObservation));
      evidence.mail = await watch.mailWithBodies();
      evidence.requests = switchRequestsFor(await switchRequests(), probe);
      const activeAfter = await activeAccount();
      if (activeAfter) evidence.activeAfter = activeAfter;
    }
  }

  const verdict = probe
    ? evaluateAccountSwitchScenario({ probe, phases, escapedInteractions: watch.escaped() })
    : { checks: [], observed: {} };
  const checks = [
    { name: "finished", passed: finished === undefined, ...(finished ? { detail: finished } : {}) },
    ...verdict.checks,
  ];
  return { checks, observed: verdict.observed, watch, probe };
}
