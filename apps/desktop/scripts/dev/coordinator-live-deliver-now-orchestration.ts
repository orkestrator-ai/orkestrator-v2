import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  CoordinatorLivePlatformSummary,
  CoordinatorTranscriptMessage,
  CoordinatorTurnProjection,
} from "./coordinator-live.js";
import type { DelegationMailMessage, DelegationRecord } from "./coordinator-live-delegation.js";
import {
  createDelegationWatch,
  removeLaunchedEnvironments,
  type DelegationCoordinator,
} from "./coordinator-live-observer.js";
import { coordinatorTurn } from "./coordinator-live-orchestration.js";
import { coordinatorLiveBudgets } from "./coordinator-live-budgets.js";
import {
  deliverNowCorrectionPrompt,
  deliverNowDelegatingPrompt,
  deliverNowTerminalApplies,
  deliverNowTerminalCorrectionPrompt,
  deliverNowTerminalLaunchPrompt,
  deliverNowWorkerName,
  evaluateDeliverNowScenario,
  launchedTabId,
  type DeliverNowProbe,
  type DeliverNowTerminalInput,
} from "./coordinator-live-deliver-now.js";

type MailboxPage = { messages?: DelegationMailMessage[] };

/**
 * The deliver-now scenario's backend orchestration, shared by the live spec
 * and the credential-free test that scripts the command transport. See
 * `coordinator-live-deliver-now.ts` for what it qualifies.
 */
export async function runDeliverNowScenario(input: {
  coordinator: DelegationCoordinator;
  summary: CoordinatorLivePlatformSummary;
  cleanup: Array<() => Promise<unknown>>;
  token?: string;
  pollIntervalMs?: number;
  /** How long the harness watches for a second wake after the first (default 30 s). */
  quietMs?: number;
  /** How long a correction may take to land before the gate opens anyway. */
  steerWaitMs?: number;
}) {
  const { coordinator, summary, cleanup } = input;
  const { invoke, identity, projectId } = coordinator;
  const platform = identity.agent;
  await removeLaunchedEnvironments(invoke, projectId, cleanup);
  const gateDirectory = await mkdtemp(path.join(tmpdir(), "coordinator-live-deliver-now-"));
  cleanup.push(() => rm(gateDirectory, { recursive: true, force: true }));
  const probe: DeliverNowProbe = {
    platform,
    token: input.token ?? randomBytes(6).toString("hex"),
    startedPath: path.join(gateDirectory, "started"),
    gatePath: path.join(gateDirectory, "finish.go"),
    terminalStartedPath: path.join(gateDirectory, "terminal-started"),
    terminalGatePath: path.join(gateDirectory, "terminal-finish.go"),
  };
  const budgets = coordinatorLiveBudgets();
  const watch = createDelegationWatch(invoke, coordinator, summary, input.pollIntervalMs);
  const turnMessages = (rowsBefore: number) =>
    (watch.projection()?.messages ?? []).slice(rowsBefore);
  const name = deliverNowWorkerName(probe);
  const findWorker = () => watch.workers.find((id) => watch.workerName(id) === name);

  let finished: string | undefined;
  let worker: string | undefined;
  let correctionResults: string[] = [];
  let correctionEndedAt: number | undefined;
  let gateOpenedAt: number | undefined;
  let wakeWindowEndedAt: number | undefined;
  let terminal: DeliverNowTerminalInput | undefined;
  try {
    await coordinatorTurn(
      watch,
      coordinator,
      "the delegating turn",
      deliverNowDelegatingPrompt(probe),
    );
    await watch.until("the launched worker", () => findWorker() !== undefined);
    worker = findWorker()!;
    const workerId = worker;

    // The worker is inside its turn, parked on the gate.
    await watch.until(
      "the worker to start its gated step",
      (observation) =>
        existsSync(probe.startedPath) &&
        ["working", "waiting"].includes(observation.workerPhases?.[workerId] ?? ""),
    );
    const correction = await coordinatorTurn(
      watch,
      coordinator,
      "the correction turn",
      deliverNowCorrectionPrompt(probe, workerId),
    );
    correctionEndedAt = correction.endedAt;
    correctionResults = await watch.toolOutputs(
      "send_message",
      turnMessages(correction.rowsBefore),
    );
    // A steer lands at once; anything else is judged as it stands now.
    await watch
      .until(
        "the correction to reach the worker",
        (observation) =>
          observation.mail.some(
            (message) => message.toEnvironmentId === workerId && message.placement === "injected",
          ),
        input.steerWaitMs ?? budgets.step / 4,
      )
      .catch(() => undefined);
    await writeFile(probe.gatePath, "go\n");
    gateOpenedAt = Date.now();
    await watch.until("the worker's report to wake the coordinator", (observation) =>
      observation.delegations.some(
        (delegation) => delegation.environmentId === workerId && delegation.wokenAt !== undefined,
      ),
    );
    // The wake turn runs and ends; a second wake would start within the window.
    let woke = false;
    let idleReads = 0;
    await watch.until("the coordinator's wake turn", (observation) => {
      if (observation.coordinatorPhase !== "idle") woke = true;
      idleReads = observation.coordinatorPhase === "idle" ? idleReads + 1 : 0;
      return woke && idleReads >= 2 && observation.queueLength === 0;
    });
    await new Promise((resolve) => setTimeout(resolve, input.quietMs ?? 30_000));
    await watch.observe();
    wakeWindowEndedAt = Date.now();

    if (deliverNowTerminalApplies(platform)) {
      terminal = { correctionResults: [], mailReads: [] };
      const launch = await coordinatorTurn(
        watch,
        coordinator,
        "the terminal launch turn",
        deliverNowTerminalLaunchPrompt(probe, workerId),
      );
      const tabId = (await watch.toolOutputs("launch_terminal", turnMessages(launch.rowsBefore)))
        .map(launchedTabId)
        .find((id): id is string => id !== null);
      if (!tabId) throw new Error("launch_terminal returned no tab");
      terminal.tabId = tabId;
      const readTerminal = async () => {
        const page = await invoke<MailboxPage>("get_agent_mail_mailbox", {
          environmentId: workerId,
          tabId,
          limit: 50,
        }).catch(() => ({ messages: [] }) as MailboxPage);
        const messages = await withBodies(invoke, page.messages ?? []);
        terminal!.mailReads.push(messages);
        return messages;
      };
      await watch.until("the terminal worker to start its gated step", () =>
        existsSync(probe.terminalStartedPath),
      );
      const terminalCorrection = await coordinatorTurn(
        watch,
        coordinator,
        "the terminal correction turn",
        deliverNowTerminalCorrectionPrompt(probe, workerId, tabId),
      );
      terminal.correctionResults = await watch.toolOutputs(
        "send_message",
        turnMessages(terminalCorrection.rowsBefore),
      );
      await readTerminal();
      await writeFile(probe.terminalGatePath, "go\n");
      terminal.gateOpenedAt = Date.now();
      const deadline = Date.now() + budgets.step;
      while (!(await readTerminal()).some((message) => message.placement === "injected")) {
        if (Date.now() >= deadline) {
          throw new Error(
            `${platform}: the terminal correction was not delivered within ${budgets.step / 1_000}s of its turn ending`,
          );
        }
        await watch.observe();
        await new Promise((resolve) => setTimeout(resolve, input.pollIntervalMs ?? 2_000));
      }
      await watch.coordinatorSettled("the coordinator after the terminal case");
    }
  } catch (error) {
    finished = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
  }

  const mail = await watch.mailWithBodies();
  const workerMessages = worker
    ? ((
        await invoke<CoordinatorTurnProjection | null>("get_native_agent_projection", {
          environmentId: worker,
          agent: platform,
          logicalSessionKey: `env-${worker}:startup-agent`,
          messageLimit: 200,
        }).catch(() => null)
      )?.messages ?? [])
    : [];
  const delegations: DelegationRecord[] = (watch.observations.at(-1)?.delegations ?? []).slice();
  const checks = [
    { name: "finished", passed: finished === undefined, ...(finished ? { detail: finished } : {}) },
    ...evaluateDeliverNowScenario({
      probe,
      coordinatorEnvironmentId: identity.environmentId,
      ...(worker ? { workerEnvironmentId: worker } : {}),
      correctionResults,
      ...(correctionEndedAt !== undefined ? { correctionEndedAt } : {}),
      ...(gateOpenedAt !== undefined ? { gateOpenedAt } : {}),
      ...(wakeWindowEndedAt !== undefined ? { wakeWindowEndedAt } : {}),
      observations: watch.observations,
      mail,
      workerMessages: workerMessages as CoordinatorTranscriptMessage[],
      delegations,
      escapedInteractions: watch.escaped(),
      workerInteractions: watch.workerEscaped(),
      ...(deliverNowTerminalApplies(platform)
        ? { terminal: terminal ?? { correctionResults: [], mailReads: [] } }
        : {}),
    }),
  ];
  return { checks, watch, mail, probe };
}

async function withBodies(
  invoke: DelegationCoordinator["invoke"],
  messages: readonly DelegationMailMessage[],
): Promise<DelegationMailMessage[]> {
  return Promise.all(
    messages.map(async (message) => {
      const full = await invoke<{ body?: string } | null>("get_agent_mail_message", {
        environmentId: message.toEnvironmentId,
        tabId: message.toTabId,
        messageId: message.id,
      }).catch(() => null);
      return typeof full?.body === "string" ? { ...message, body: full.body } : message;
    }),
  );
}
