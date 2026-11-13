#!/usr/bin/env bun
/**
 * Real-stack check of the remote goal hold (to-do 4860 (retired) task 2;
 * `docs/architecture/goals.md`, "Verifier and other surfaces";
 * `docs/architecture/coordinator.md`, "Status wakes").
 *
 * A worker on another node that is between goal iterations reads `idle`, and
 * that idle is the loop's, not the worker's answer: its coordinator must not
 * be woken until the goal stops. This runs that path across a real node link:
 *
 * - Two backends of this checkout (`mixed-version/harness.ts`: own data
 *   directory, HOME and loopback port each, a constructed environment with
 *   nothing `ORKESTRATOR_*` inherited, `agent-test` runtime with no toolchain
 *   and no credentials, so no agent turn and no provider request can happen).
 *   The command node attaches the leaf.
 * - The leaf gets a worker environment with a native tab (the fixtures'
 *   `create_environment` and `start_environment`). It is stopped, and its
 *   tab's session is given a goal in `checking` whose check waits for a file
 *   this script creates later; then it is started again. Its own goal
 *   service picks the goal up at start (`NativeAgentGoalService.init`) and
 *   runs the check in the worktree. That is the state between two
 *   iterations: the tab idle, the goal running. No turn is sent: a check
 *   needs no agent, and this host must make no provider request.
 * - The coordinator is the production `CoordinatorService` on a real mail
 *   store (`MailWorld`; only its agents are simulated), reading the worker
 *   through the production `NodeCoordinatorRemote` over the command node's
 *   `invoke_on_node`, so every read crosses the real link to the real leaf.
 *   Mail collection answers "collected" with nothing to collect: the worker
 *   sends no report.
 *
 * Checks: while the check runs the leaf's registry says idle with the goal
 * running, the delegation stays open and the coordinator is not woken over
 * several reads past the start-up grace; once the file exists the check
 * passes, the goal completes, and the next read closes the delegation and
 * wakes the coordinator once, naming the node.
 *
 *   mise run qa:remote-goal-hold -- [--report <file>] [--keep]
 *   bun scripts/qa-remote-goal-hold.ts [--report <file>] [--keep]
 *
 * Scheduled weekly by `.github/workflows/mixed-version-qualification.yml`.
 * `tests/unit/qa-remote-goal-hold.test.ts` runs the seeded goal through the
 * registry, `NodeCoordinatorRemote` and the coordinator in process.
 *
 * Exits 0 when every check passed, 1 when one failed, 2 on a setup error.
 * Only the two backends it started are signalled, through their handles.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { NativeAgentGoal } from "@orkestrator/protocol/native-agent-goal";
import type { AgentRegistrySnapshot } from "@orkestrator/protocol/agent-registry";
import type { NodeSummariesResult } from "@orkestrator/protocol/node-summaries";

import { MailWorld } from "../apps/backend/src/core/agent-mail-world-test-support.ts";
import { nativeAgentSessionStorageKey } from "../apps/backend/src/core/native-agent-service-shared.ts";
import { NodeCoordinatorRemote } from "../apps/backend/src/core/nodes/node-coordinator-remote.ts";
import { StorageService } from "../apps/backend/src/core/storage.ts";
import { WorkerTabCloseAdmission } from "../apps/backend/src/core/worker-tab-close-admission.ts";
import { currentCommands } from "./qualify-contract-mixed-versions.ts";
import { PairFixtures } from "./mixed-version/fixtures.ts";
import { makeNode, ROOT, tokenLeaks, until, type PeerNode } from "./mixed-version/harness.ts";
import { gatewayInvoker } from "./mixed-version/scenarios/coordinator-list-nodes.ts";

/** The coordinator's start-up grace (`DELEGATION_IDLE_RECONCILE_GRACE_MS`) and a margin. */
const PAST_GRACE_MS = 15_000 + 3_000;
/** Reads of the held worker after the grace has passed. */
const HELD_READS = 4;
const READ_INTERVAL_MS = 3_000;

interface Check {
  readonly id: string;
  readonly description: string;
  readonly ok: boolean;
  readonly detail?: string;
}

/** The goal a worker has between iterations: one sent, its check running. */
export function heldGoal(input: {
  providerSessionId: string;
  check: string;
  now: Date;
}): NativeAgentGoal {
  const at = input.now.toISOString();
  return {
    goalId: `qualification-goal-${input.now.getTime()}`,
    objective: "Remote goal hold qualification: the check waits for a file the harness creates.",
    check: input.check,
    status: "checking",
    providerSessionId: input.providerSessionId,
    iterations: 1,
    maxIterations: 3,
    tokensAtStart: 0,
    noProgressStreak: 0,
    setAt: at,
    updatedAt: at,
  };
}

/** A check that passes once `file` exists, and waits until then. */
export function waitForFileCheck(file: string): string {
  const quoted = `'${file.replaceAll("'", `'"'"'`)}'`;
  return `until [ -f ${quoted} ]; do sleep 1; done`;
}

/** A worker tab's native session, keyed as the leaf's registry reads its goal (`AgentRegistry`). */
export function workerSessionKey(worker: { environmentId: string; tabId: string }): {
  key: string;
  logicalSessionKey: string;
} {
  const logicalSessionKey = `env-${worker.environmentId}:${worker.tabId}`;
  return {
    key: nativeAgentSessionStorageKey(worker.environmentId, "claude", logicalSessionKey),
    logicalSessionKey,
  };
}

/**
 * Give a worker tab a running goal in the stopped leaf's data directory.
 * Answers the goal it stored.
 */
export async function seedGoal(
  dataDir: string,
  worker: { environmentId: string; tabId: string },
  check: string,
): Promise<NativeAgentGoal> {
  const storage = new StorageService(dataDir);
  await storage.init();
  try {
    const { key, logicalSessionKey } = workerSessionKey(worker);
    const session = await storage.getOrCreateNativeAgentSession(
      { key, environmentId: worker.environmentId, agent: "claude", logicalSessionKey },
      async () => `qualification-session-${Date.now()}`,
    );
    const goal = heldGoal({
      providerSessionId: session.providerSessionId,
      check,
      now: new Date(),
    });
    const updated = await storage.updateNativeAgentGoal(key, () => goal);
    if ((updated?.goal as { goalId?: string } | undefined)?.goalId !== goal.goalId) {
      throw new Error("The leaf's session did not take the goal.");
    }
    return goal;
  } finally {
    storage.close();
  }
}

async function attach(command: PeerNode, leaf: PeerNode): Promise<void> {
  await command.invoke("set_command_node_enabled", { enabled: true });
  await command.invoke("add_node", {
    routes: [{ id: "loopback", kind: "https", enabled: true, origin: leaf.origin }],
    token: leaf.token,
    displayName: leaf.name,
  });
}

function leafAvailable(command: PeerNode, leaf: PeerNode) {
  return until(
    `${command.label} to see ${leaf.label} connected`,
    () => command.invoke<NodeSummariesResult>("get_node_summaries", { nodeIds: [leaf.id] }),
    (value) => value.nodes.some((node) => node.nodeId === leaf.id && node.available),
    120_000,
  );
}

export async function runGoalHold(options: { keep: boolean }): Promise<{
  checks: Check[];
  evidence: Record<string, unknown>[];
  setupError?: string;
}> {
  const checks: Check[] = [];
  const evidence: Record<string, unknown>[] = [];
  const check = (id: string, description: string, ok: boolean, detail?: string) => {
    checks.push({ id, description, ok, ...(detail && !ok ? { detail } : {}) });
    console.log(
      `  ${ok ? "PASS" : "FAIL"} ${id} ${description}${ok || !detail ? "" : ` (${detail})`}`,
    );
    return ok;
  };
  const root = await mkdtemp(path.join(os.tmpdir(), "ork-remote-goal-hold-"));
  const nodes: PeerNode[] = [];
  let world: MailWorld | undefined;
  let setupError: string | undefined;
  try {
    const commands = currentCommands();
    const command = await makeNode({
      name: "Command",
      role: "command",
      build: { kind: "current" },
      root,
      commands,
    });
    const leaf = await makeNode({
      name: "Leaf",
      role: "leaf",
      build: { kind: "current" },
      root,
      commands,
    });
    nodes.push(command, leaf);
    await Promise.all(nodes.map((node) => node.start()));
    await attach(command, leaf);
    await leafAvailable(command, leaf);
    const fixtures = new PairFixtures(path.join(root, "fixtures"));
    await fixtures.project(command);
    const worker = await fixtures.worker(leaf);
    console.log("[goal-hold] leaf worker ready; seeding a goal between iterations");

    const release = path.join(root, "release-goal-check");
    await leaf.stop();
    await seedGoal(path.join(leaf.dir, "data"), worker, waitForFileCheck(release));
    await leaf.start();
    await leafAvailable(command, leaf);

    const invoke = gatewayInvoker(command);
    const remote = new NodeCoordinatorRemote({
      invokeOnNode: (input) => invoke("invoke_on_node", { ...input }),
      summaries: (nodeIds) => invoke("get_node_summaries", nodeIds ? { nodeIds } : {}),
      // The worker sends no report, so there is nothing in its outbox.
      collectMail: async () => true,
    });
    const registryEntry = async () => {
      const routed = await invoke<{ outcome: string; result?: AgentRegistrySnapshot }>(
        "invoke_on_node",
        {
          nodeId: leaf.id,
          command: "get_agent_registry",
          args: { environmentId: worker.environmentId },
        },
      );
      return routed.result?.entries.find(
        (entry) => entry.environmentId === worker.environmentId && entry.tabId === worker.tabId,
      );
    };
    const held = await until(
      "the leaf's goal service to pick the goal up",
      registryEntry,
      (entry) => entry?.goal?.status === "checking",
      60_000,
    );
    check(
      "GH-01",
      "the leaf's registry, read over the link, says the worker tab is idle with its goal running",
      held?.state === "idle" && held.goal?.running === true,
      `state ${String(held?.state)}, goal ${JSON.stringify(held?.goal ?? null)}`,
    );
    evidence.push({ step: "held", state: held?.state, goal: held?.goal ?? null });

    world = await MailWorld.create({ statusWakes: { coalesceMs: 0 } });
    world.coordinator.setRemoteAccess(remote);
    const main = await world.main();
    const association = await world.storage.coordinators.saveCoordinatorWorkflowAssociation({
      id: "remote-goal-hold",
      projectId: world.projectId,
      coordinatorId: world.coordinatorId,
      conversationId: main.conversationId!,
      kind: "environment",
      resourceId: worker.environmentId,
      nodeId: leaf.id,
      requestId: "remote-goal-hold-launch",
      baseBranch: "main",
      baseCommit: "a".repeat(40),
      createdAt: new Date().toISOString(),
    });
    await world.storage.coordinators.openCoordinatorDelegation(
      new WorkerTabCloseAdmission(),
      association.id,
      worker.tabId,
    );
    const delegation = async () =>
      (
        await world!.storage.coordinators.listCoordinatorWorkflowAssociations(world!.projectId)
      ).find((entry) => entry.id === association.id)?.delegation;
    const settle = async () => {
      await world!.coordinator.settleRemoteWorker(leaf.id, worker.environmentId);
      await world!.coordinator.reconcileWorkflowNotifications();
      await world!.deliver();
    };

    // Inside the grace an idle worker stays open anyway; the hold matters after it.
    await settle();
    await Bun.sleep(PAST_GRACE_MS);
    const heldStates: string[] = [];
    for (let read = 0; read < HELD_READS; read++) {
      await settle();
      const entry = await registryEntry();
      heldStates.push(`${String(entry?.state)}/${String(entry?.goal?.status)}`);
      await Bun.sleep(READ_INTERVAL_MS);
    }
    const whileHeld = await delegation();
    check(
      "GH-02",
      `past the grace, ${HELD_READS} reads of the idle worker keep the delegation open while its goal runs`,
      whileHeld?.state === "running" && heldStates.every((entry) => entry === "idle/checking"),
      `${String(whileHeld?.state)}; reads ${heldStates.join(", ")}`,
    );
    check(
      "GH-03",
      "the coordinator is not woken while the goal holds the worker",
      world.wakes(main) === 0 && world.received(main).length === 0,
      `${world.wakes(main)} wakes`,
    );
    evidence.push({ step: "while held", reads: heldStates, delegation: whileHeld?.state ?? null });

    await writeFile(release, "");
    const ended = await until(
      "the leaf's check to pass and the goal to complete",
      registryEntry,
      (entry) => entry?.goal !== undefined && entry.goal.running === false,
      60_000,
    );
    check(
      "GH-04",
      "the check passes in the leaf's worktree and the goal completes on the leaf",
      ended?.goal?.status === "complete" && ended.state === "idle",
      `state ${String(ended?.state)}, goal ${JSON.stringify(ended?.goal ?? null)}`,
    );
    await settle();
    const closed = await delegation();
    const received = world.received(main);
    // The notice names the worker's node as the command node's registry does.
    const nodeName = await remote.nodeName(leaf.id);
    const heading = received[0]?.split("\n").find((line) => line.includes("nodeId")) ?? "";
    check(
      "GH-05",
      "the next read closes the delegation and wakes the coordinator once, naming the node",
      closed?.state === "completed" &&
        world.wakes(main) === 1 &&
        received.length === 1 &&
        received[0]!.includes(`on ${nodeName} (nodeId ${leaf.id})`),
      `${String(closed?.state)}, ${world.wakes(main)} wakes, ${received.length} notices; ${heading.slice(0, 200)}`,
    );
    evidence.push({
      step: "after the goal",
      goal: ended?.goal ?? null,
      delegation: closed?.state ?? null,
      wakeKind: closed?.wakeKind ?? null,
      wakes: world.wakes(main),
      noticeNamesNode: received[0]?.includes(`on ${nodeName} (nodeId ${leaf.id})`) ?? false,
    });
  } catch (error) {
    setupError = String(error).slice(0, 2_000);
    console.error(setupError);
  } finally {
    await world?.close().catch(() => undefined);
    await Promise.all(nodes.map((node) => node.stop().catch(() => undefined)));
    const leaks = tokenLeaks(nodes);
    check(
      "GH-06",
      "no gateway token appears in either backend's output",
      leaks.length === 0,
      leaks.join(", "),
    );
    if (options.keep) console.log(`Kept ${root}`);
    else await rm(root, { recursive: true, force: true });
  }
  return { checks, evidence, ...(setupError ? { setupError } : {}) };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const reportAt = argv.indexOf("--report");
  const report = reportAt >= 0 ? argv[reportAt + 1] : undefined;
  const result = await runGoalHold({ keep: argv.includes("--keep") });
  const passed = result.checks.filter((entry) => entry.ok).length;
  console.log(
    `goal-hold: ${passed}/${result.checks.length} checks${result.setupError ? "; setup error" : ""}`,
  );
  if (report) {
    const file = path.resolve(report);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`Report: ${path.relative(ROOT, file) || file}`);
  }
  process.exit(result.setupError ? 2 : passed === result.checks.length ? 0 : 1);
}
