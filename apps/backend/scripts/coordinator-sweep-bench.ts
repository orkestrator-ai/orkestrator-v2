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

/**
 * What the coordinator-repair sweep and a coordinator read cost, against a
 * synthetic data directory in the system temporary directory:
 *
 *   mise exec -- bun apps/backend/scripts/coordinator-sweep-bench.ts \
 *     [--projects 40] [--open 10] [--finished 35] [--iterations 20]
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
 */

const projects = Math.max(1, option("projects", 40));
const open = option("open", 10);
const finished = option("finished", 35);
const iterations = Math.max(1, option("iterations", 20));

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
    for (let worker = 0; worker < open + finished; worker += 1) {
      const running = worker < open;
      const environment = createEnvironment(project.id, {
        name: `worker-${index}-${worker}`,
        environmentType: "local",
      });
      environment.status = "running";
      if (running) await storage.addEnvironment(environment);
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

  const sweep = await measure(() => coordinator.reconcileWorkerDelegations());
  const read = await measure((index) => coordinator.get(projectIds[index % projectIds.length]!));
  const views = createCommandRegistry().get("get_project_coordinator_view")!;
  const context = { storage, coordinators: coordinator } as unknown as CommandContext;
  const view = await measure(async (index) =>
    views({ projectId: projectIds[index % projectIds.length]! }, context),
  );
  const records = (await storage.coordinators.getCoordinatorReconciliationState()).workflows.length;
  log(
    JSON.stringify({ projects, open, finished, records, iterations, sweep, read, view }, null, 2),
  );
  storage.close();
} finally {
  await rm(root, { recursive: true, force: true });
}
