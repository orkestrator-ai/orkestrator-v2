import { randomBytes } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  describeDigestChanges,
  fixtureTreeDigest,
  transcriptToolCalls,
  type CoordinatorLivePlatformSummary,
} from "./coordinator-live.js";
import { coordinatorLiveBudgets } from "./coordinator-live-budgets.js";
import type { DelegationMailMessage } from "./coordinator-live-delegation.js";
import {
  createDelegationWatch,
  removeLaunchedEnvironments,
  type DelegationCoordinator,
} from "./coordinator-live-observer.js";
import { coordinatorTurn } from "./coordinator-live-orchestration.js";
import {
  evaluateSurfacesScenario,
  launchedTabId,
  rootChangesRequestId,
  SURFACES_TOOLS,
  surfacesPrompt,
  surfacesRootFile,
  surfacesTerminalSessionId,
  surfacesWorkerInput,
  surfacesWorkerName,
  type SurfacesProbe,
  terminalShowsMarker,
} from "./coordinator-live-surfaces.js";

/** One `list_node_action_requests` row, as far as the harness reads it. */
interface ActionRequestRow {
  requestId: string;
  kind?: string;
  state: string;
}

/** What the harness hands the approver: enough to find the dialog, never file contents. */
export interface RootChangesApproval {
  requestId: string;
  /** The checkout-relative file the coordinator named. */
  file: string;
  workerName: string;
}

/**
 * The surfaces scenario's backend orchestration, shared by the live spec and
 * the credential-free test that scripts the command transport. See
 * `coordinator-live-surfaces.ts` for what it qualifies.
 *
 * `approveRootChanges` is the user's part: the spec clicks Apply in the
 * profile's own approval dialog. It runs only once the request is pending.
 */
export async function runSurfacesScenario(input: {
  coordinator: DelegationCoordinator;
  summary: CoordinatorLivePlatformSummary;
  cleanup: Array<() => Promise<unknown>>;
  /** The fixture project's checkout, which the scenario writes one untracked file into. */
  checkout: string;
  approveRootChanges: (request: RootChangesApproval) => Promise<void>;
  token?: string;
  pollIntervalMs?: number;
  /** How long the harness watches for a second wake after the first (default 30 s). */
  quietMs?: number;
  /** How long the harness waits for the terminal's echoed marker after the turn (default 30 s). */
  terminalWaitMs?: number;
}) {
  const { coordinator, summary, cleanup, checkout } = input;
  const { invoke, identity, projectId } = coordinator;
  const coordinatorEnvironmentId = identity.environmentId;
  // Removes the worker made here too: it did not exist before.
  await removeLaunchedEnvironments(invoke, projectId, cleanup);
  const token = input.token ?? randomBytes(6).toString("hex");
  const budgets = coordinatorLiveBudgets();

  // The worker is made by the harness, so the coordinator needs the
  // project's explicit opt-in before it may act on it.
  const config = await invoke<{
    repositories: Record<string, { coordinatorOtherEnvironments?: boolean }>;
  }>("get_config");
  const previousOtherEnvironments = config.repositories[projectId]?.coordinatorOtherEnvironments;
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
  await invoke("patch_repository_settings", {
    projectId,
    updates: { coordinatorOtherEnvironments: true },
  });

  const worker = await invoke<{ id: string }>(
    "create_environment",
    surfacesWorkerInput({ projectId, token }),
  );
  await invoke("start_environment", { environmentId: worker.id });
  const worktree = (
    await invoke<{ worktreePath?: string | null }>("get_environment", {
      environmentId: worker.id,
    })
  ).worktreePath;
  if (!worktree) throw new Error("the surfaces worker has no worktree");

  // The uncommitted change the user copies into the worker. Removed last, so
  // the checkout is measured with it in place both times.
  const rootFile = surfacesRootFile(token);
  const rootPath = path.join(checkout, rootFile.path);
  await writeFile(rootPath, rootFile.content);
  cleanup.push(() => rm(rootPath, { force: true }));
  const before = await fixtureTreeDigest(checkout);

  const probe: SurfacesProbe = {
    platform: identity.agent,
    token,
    workerEnvironmentId: worker.id,
  };
  const watch = createDelegationWatch(invoke, coordinator, summary, input.pollIntervalMs);
  const pollMs = input.pollIntervalMs ?? 2_000;
  const readRequest = async (requestId: string) =>
    (await invoke<ActionRequestRow[]>("list_node_action_requests", {})).find(
      (row) => row.requestId === requestId,
    );

  let finished: string | undefined;
  let rowsBefore = watch.projection()?.messages.length ?? 0;
  let outputs: Partial<Record<(typeof SURFACES_TOOLS)[number], string[]>> = {};
  let layoutAfter: unknown = null;
  let terminalOutput: string | null = null;
  let request: ActionRequestRow | undefined;
  let approved = false;
  let approvedAt: number | undefined;
  let wakeObservationEnd: number | undefined;
  try {
    rowsBefore = (
      await coordinatorTurn(watch, coordinator, "the surfaces turn", surfacesPrompt(probe))
    ).rowsBefore;
    const turnMessages = (watch.projection()?.messages ?? []).slice(rowsBefore);
    outputs = Object.fromEntries(
      await Promise.all(
        SURFACES_TOOLS.map(
          async (tool) => [tool, await watch.toolOutputs(tool, turnMessages)] as const,
        ),
      ),
    );
    // The tab opening is not the command running: read the tab's output
    // until the line its `echo` prints shows, or the wait ends. A failed read
    // leaves the last answer (null if none), which the verdict reports.
    const terminalTab = (outputs.launch_terminal ?? []).map(launchedTabId).find(Boolean);
    if (terminalTab) {
      const sessionId = surfacesTerminalSessionId(worker.id, terminalTab);
      const terminalDeadline = Date.now() + (input.terminalWaitMs ?? 30_000);
      for (;;) {
        const snapshot = await invoke<{ output?: unknown }>("get_terminal_output_snapshot", {
          sessionId,
        }).catch(() => null);
        if (typeof snapshot?.output === "string") terminalOutput = snapshot.output;
        if (terminalOutput !== null && terminalShowsMarker(terminalOutput, token)) break;
        if (Date.now() >= terminalDeadline) break;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(pollMs, Math.max(0, terminalDeadline - Date.now()))),
        );
      }
    }
    layoutAfter = await invoke<unknown>("get_pane_layout", { environmentId: worker.id });

    const requestId = (outputs.request_root_changes ?? []).map(rootChangesRequestId).find(Boolean);
    if (!requestId) throw new Error("request_root_changes asked for no approval");
    await watch.until("the root changes request to be pending", async () => {
      request = await readRequest(requestId);
      return request?.state === "pending";
    });
    approvedAt = Date.now();
    await input.approveRootChanges({
      requestId,
      file: rootFile.path,
      workerName: surfacesWorkerName(token),
    });
    approved = true;

    // The request runs, then the outcome is mailed and the coordinator woken.
    const previousTurnIds = new Set(watch.observations.at(-1)?.coordinatorTurnIds ?? []);
    let woke = false;
    let idleReads = 0;
    await watch.until(
      "the root changes outcome and the coordinator's wake turn",
      async (observation) => {
        request = await readRequest(requestId);
        if (
          observation.coordinatorPhase !== "idle" ||
          observation.coordinatorTurnIds?.some((id) => !previousTurnIds.has(id))
        )
          woke = true;
        idleReads = observation.coordinatorPhase === "idle" ? idleReads + 1 : 0;
        const settled = request !== undefined && !["pending", "approved"].includes(request.state);
        return settled && woke && idleReads >= 2 && observation.queueLength === 0;
      },
      budgets.step * 2,
    );

    const quietDeadline = Date.now() + (input.quietMs ?? 30_000);
    do {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(pollMs, Math.max(0, quietDeadline - Date.now()))),
      );
      await watch.observe();
    } while (Date.now() < quietDeadline);
    wakeObservationEnd = watch.observations.length;
  } catch (error) {
    finished = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
  }

  const workerFile = await readFile(path.join(worktree, rootFile.path), "utf8").catch(() => null);
  const after = await fixtureTreeDigest(checkout);
  const mail: DelegationMailMessage[] = await watch.mailWithBodies();
  const messages = (watch.projection()?.messages ?? []).slice(rowsBefore);
  const checks = [
    { name: "finished", passed: finished === undefined, ...(finished ? { detail: finished } : {}) },
    ...evaluateSurfacesScenario({
      coordinatorEnvironmentId,
      calls: transcriptToolCalls(messages),
      outputs,
      token,
      terminalOutput,
      layoutAfter,
      ...(request ? { request } : {}),
      approved,
      workerFile,
      expectedFile: rootFile.content,
      checkoutBefore: before.digest,
      checkoutAfter: after.digest,
      checkoutChanges: describeDigestChanges(before, after),
      ...(approvedAt !== undefined ? { approvedAt } : {}),
      observations: watch.observations.slice(0, wakeObservationEnd),
      mail,
      escapedInteractions: watch.escaped(),
    }),
  ];
  return { checks, watch, mail, probe };
}
