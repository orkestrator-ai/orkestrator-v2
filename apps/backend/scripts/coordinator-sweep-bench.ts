import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { coordinatorMainConversation } from "@orkestrator/protocol/coordinator";
import type { CommandContext } from "../src/core/commands-context.js";
import { createCommandRegistry } from "../src/core/commands-registry.js";
import { CoordinatorService } from "../src/core/coordinator-service.js";
import { runCommand } from "../src/core/shell.js";
import type { StorageContext } from "../src/core/storage-context.js";
import { createEnvironment, createProject, StorageService } from "../src/core/storage.js";
import { benchOption as option } from "./agent-mail-bench-fixture.js";
import { patchMethod } from "./bench-method-patch.js";

/**
 * What the coordinator-repair sweep and a coordinator read cost, against a
 * synthetic data directory in the system temporary directory:
 *
 *   mise exec -- bun apps/backend/scripts/coordinator-sweep-bench.ts \
 *     [--projects 40] [--open 10] [--finished 35] [--iterations 20] [--owed 0]
 *
 * Each project has a coordinator with one main conversation, `open` running
 * worker delegations (one running local environment each) and `finished`
 * delegations that were closed and woken, so the defaults hold 1,800 of the
 * store's 2,000 workflow records.
 *
 * `sweep` is one `reconcileWorkerDelegations`, which the 60 s
 * `coordinator-repair` job runs. `read` is one `CoordinatorService.get`, which
 * `get_project_coordinator`, the panel's view and every coordinator
 * `read_messages` call; `view` is the panel's `get_project_coordinator_view`,
 * which also digests the answer. Writes are the committed revisions of the
 * coordinator and agent mail stores per call. Each figure is the mean per
 * call; machine- and load-specific, so compare runs on one host only.
 *
 * `--owed N` adds the wake measurement (to-do 6660, task 2): before each
 * measured sweep, N delegations (spread over the projects, whose mains are
 * open with an agent) finish without being woken, so the sweep's wake pass
 * delivers N wakes. `wakes` is that sweep as it runs; `wakesWithoutRepair`
 * is the same sweep with each wake's `ensureMainConversation` reduced to its
 * open-main lookup, which is what skipping the per-wake repair would leave.
 * The two alternate, so both see the same store growth. `repairMsPerWake`
 * and `syncsPerPass` come from timing the real `ensureMainConversation` and
 * counting `synchronizeAgentMailboxes` calls in the repairing passes. Writes
 * are per pass and leave out the owed records' own seeding. Each iteration
 * runs two passes and adds `2 × owed` records, so keep
 * `projects × (open + finished) + 2 × owed × (iterations + 1)` under 2,000
 * (`--projects 40 --open 10 --finished 0 --owed 40 --iterations 10` fits).
 */

const projects = Math.max(1, option("projects", 40));
const open = option("open", 10);
const finished = option("finished", 35);
const iterations = Math.max(1, option("iterations", 20));
const owed = option("owed", 0);

const root = await mkdtemp(path.join(tmpdir(), "ork-coordinator-sweep-bench-"));
const log = console.log.bind(console);
const quiet = () => {};
console.log = quiet;
console.info = quiet;
console.warn = quiet;
console.debug = quiet;

const round = (value: number) => Math.round(value * 100) / 100;

try {
  const storage = new StorageService(path.join(root, "data"));
  await storage.init();
  const config = await storage.loadConfig();
  await storage.updateGlobalConfig({
    ...config.global,
    agentSettings: { ...config.global.agentSettings, defaultAgent: "codex" },
  });
  const coordinator = new CoordinatorService(
    storage,
    () => ({ enabled: true, running: true, error: null }),
    undefined,
    undefined,
    {},
  );
  const database = (storage as unknown as { context: StorageContext }).context.database;
  const revisions = () => ({
    coordinators: database.storeRevision("coordinators") ?? 0,
    mail: database.storeRevision("agent-mail") ?? 0,
  });

  const projectIds: string[] = [];
  const projectRefs: Array<{ projectId: string; coordinatorId: string; mainId: string }> = [];
  const environmentsByProject: string[][] = [];
  const at = new Date().toISOString();
  for (let index = 0; index < projects; index += 1) {
    const checkout = path.join(root, `checkout-${index}`);
    await mkdir(checkout);
    await runCommand("git", ["init", "-q", "-b", "main"], { cwd: checkout });
    const project = await storage.addProject(
      createProject(`https://example.invalid/bench-${index}.git`, checkout),
    );
    projectIds.push(project.id);
    const snapshot = await coordinator.ensure(project.id);
    const main = coordinatorMainConversation(snapshot.workspace)!;
    await coordinator.assignConversationAgent(project.id, main.id, "codex");
    projectRefs.push({
      projectId: project.id,
      coordinatorId: snapshot.workspace.id,
      mainId: main.id,
    });
    environmentsByProject.push([]);
    for (let worker = 0; worker < open + finished; worker += 1) {
      const running = worker < open;
      const environment = createEnvironment(project.id, {
        name: `worker-${index}-${worker}`,
        environmentType: "local",
      });
      environment.status = "running";
      if (running) {
        await storage.addEnvironment(environment);
        environmentsByProject[index]!.push(environment.id);
      }
      await storage.coordinators.saveCoordinatorWorkflowAssociation({
        id: `bench-${index}-${worker}`,
        projectId: project.id,
        coordinatorId: snapshot.workspace.id,
        conversationId: main.id,
        kind: "environment",
        resourceId: environment.id,
        requestId: `bench-${index}-${worker}`,
        createdAt: at,
        delegation: running
          ? { requestedAt: at, workerTabId: "startup-agent", state: "running" }
          : {
              requestedAt: at,
              workerTabId: "startup-agent",
              state: "completed",
              completedAt: at,
              wokenAt: at,
            },
      });
    }
  }
  await storage.synchronizeAgentMailboxes();

  async function measure(operation: (index: number) => Promise<unknown>) {
    await operation(0);
    const before = revisions();
    const cpuBefore = process.cpuUsage();
    const started = performance.now();
    for (let index = 0; index < iterations; index += 1) await operation(index);
    const wall = performance.now() - started;
    const cpu = process.cpuUsage(cpuBefore);
    const after = revisions();
    return {
      ms: round(wall / iterations),
      cpuMs: round((cpu.user + cpu.system) / 1_000 / iterations),
      coordinatorWrites: round((after.coordinators - before.coordinators) / iterations),
      mailWrites: round((after.mail - before.mail) / iterations),
    };
  }

  let owedBatch = 0;
  /** N delegations that finished and still owe their coordinator a wake. */
  async function oweWakes(): Promise<void> {
    const batch = owedBatch++;
    const finishedAt = new Date(Date.now() + batch).toISOString();
    for (let wake = 0; wake < owed; wake += 1) {
      const projectIndex = wake % projectRefs.length;
      const ref = projectRefs[projectIndex]!;
      const environments = environmentsByProject[projectIndex]!;
      const id = `owed-${batch}-${wake}`;
      await storage.coordinators.saveCoordinatorWorkflowAssociation({
        id,
        projectId: ref.projectId,
        coordinatorId: ref.coordinatorId,
        conversationId: ref.mainId,
        kind: "environment",
        resourceId: environments[wake % Math.max(1, environments.length)] ?? `missing-${id}`,
        requestId: id,
        createdAt: at,
        delegation: {
          requestedAt: at,
          workerTabId: `startup-agent-${batch}-${wake}`,
          state: "completed",
          completedAt: finishedAt,
        },
      });
    }
  }

  type WakeTotals = { wall: number; cpuMs: number; coordinatorWrites: number; mailWrites: number };
  const zero = (): WakeTotals => ({ wall: 0, cpuMs: 0, coordinatorWrites: 0, mailWrites: 0 });

  /** One sweep that delivers `owed` fresh wakes, added to `totals`. */
  async function wakePass(totals: WakeTotals): Promise<void> {
    await oweWakes();
    const before = revisions();
    const cpuBefore = process.cpuUsage();
    const started = performance.now();
    await coordinator.reconcileWorkerDelegations();
    totals.wall += performance.now() - started;
    const cpu = process.cpuUsage(cpuBefore);
    totals.cpuMs += (cpu.user + cpu.system) / 1_000;
    const after = revisions();
    totals.coordinatorWrites += after.coordinators - before.coordinators;
    totals.mailWrites += after.mail - before.mail;
    const unwoken = (await storage.coordinators.listUnwokenCoordinatorDelegations()).length;
    if (unwoken > 0) throw new Error(`${unwoken} owed wakes were not delivered`);
  }

  const perPass = (totals: WakeTotals) => ({
    ms: round(totals.wall / iterations),
    cpuMs: round(totals.cpuMs / iterations),
    coordinatorWrites: round(totals.coordinatorWrites / iterations),
    mailWrites: round(totals.mailWrites / iterations),
  });

  /**
   * The two variants alternate, in both orders, so each sees the same store
   * growth: every pass adds `owed` records and as many mails.
   */
  async function measureWakes() {
    const service = coordinator as unknown as {
      ensureMainConversation: CoordinatorService["ensureMainConversation"];
    };
    const realEnsure = coordinator.ensureMainConversation.bind(coordinator);
    const realSync = storage.synchronizeAgentMailboxes.bind(storage);
    let counting = false;
    let ensureCalls = 0;
    let ensureMs = 0;
    let syncCalls = 0;
    let syncMs = 0;
    const timedEnsure: CoordinatorService["ensureMainConversation"] = async (
      projectId,
      options,
    ) => {
      const started = performance.now();
      try {
        return await realEnsure(projectId, options);
      } finally {
        if (counting) {
          ensureMs += performance.now() - started;
          ensureCalls += 1;
        }
      }
    };
    // What skipping the repair would leave: the open main, read once.
    const lookupOnly: CoordinatorService["ensureMainConversation"] = async (projectId) => {
      const workspace = await storage.coordinators.getCoordinatorWorkspace(projectId);
      const main = workspace ? coordinatorMainConversation(workspace) : undefined;
      if (!workspace || !main?.agent) return realEnsure(projectId);
      return { workspace, main };
    };
    const restoreSync = patchMethod(storage, "synchronizeAgentMailboxes", async () => {
      const started = performance.now();
      try {
        return await realSync();
      } finally {
        if (counting) {
          syncMs += performance.now() - started;
          syncCalls += 1;
        }
      }
    });
    const restoreEnsure = patchMethod(service, "ensureMainConversation", timedEnsure);
    const withRepair = zero();
    const withoutRepair = zero();
    const run = async (repair: boolean, totals: WakeTotals) => {
      service.ensureMainConversation = repair ? timedEnsure : lookupOnly;
      counting = repair;
      await wakePass(totals);
      counting = false;
    };
    try {
      // Warm-up of both variants, not counted.
      await run(true, zero());
      await run(false, zero());
      ensureCalls = ensureMs = syncCalls = syncMs = 0;
      for (let index = 0; index < iterations; index += 1) {
        const repairFirst = index % 2 === 0;
        await run(repairFirst, repairFirst ? withRepair : withoutRepair);
        await run(!repairFirst, repairFirst ? withoutRepair : withRepair);
      }
    } finally {
      // Also when a pass throws (an undelivered wake), so nothing after it
      // runs against the patched methods.
      restoreEnsure();
      restoreSync();
    }
    return {
      wakes: perPass(withRepair),
      wakesWithoutRepair: perPass(withoutRepair),
      repairMsPerWake: round(ensureMs / Math.max(1, ensureCalls)),
      ensureCallsPerPass: round(ensureCalls / iterations),
      syncsPerPass: round(syncCalls / iterations),
      syncMsPerCall: round(syncMs / Math.max(1, syncCalls)),
    };
  }

  const sweep = await measure(() => coordinator.reconcileWorkerDelegations());
  const read = await measure((index) => coordinator.get(projectIds[index % projectIds.length]!));
  const views = createCommandRegistry().get("get_project_coordinator_view")!;
  const context = { storage, coordinators: coordinator } as unknown as CommandContext;
  const view = await measure(async (index) =>
    views({ projectId: projectIds[index % projectIds.length]! }, context),
  );
  const wakeMeasurements = owed > 0 ? await measureWakes() : {};
  const records = (await storage.coordinators.getCoordinatorReconciliationState()).workflows.length;
  log(
    JSON.stringify(
      {
        projects,
        open,
        finished,
        owed,
        records,
        iterations,
        sweep,
        read,
        view,
        ...wakeMeasurements,
      },
      null,
      2,
    ),
  );
  storage.close();
} finally {
  await rm(root, { recursive: true, force: true });
}
