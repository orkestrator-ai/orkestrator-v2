import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BackendRuntime } from "../backend-runtime.js";
import { createCommandRegistry } from "../commands-registry.js";
import type { CommandContext } from "../commands-context.js";
import { createEnvironment, createProject, StorageService } from "../storage.js";
import * as shell from "../shell.js";
import { NodeReadModel } from "./node-read-model.js";
import { TestNodeNetwork, settle } from "./node-network-test-support.js";
import { evaluatePrMergeReadiness } from "@orkestrator/protocol/pr-merge-readiness";

// No workspace subscription or PR lifecycle command: only the real summary
// handlers may arm monitoring. Timers run manually so restoration has no wait.
test("summary-only traffic starts a cold leaf monitor again after restart and relays rollup-only transitions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ork-node-pr-health-"));
  const storage = new StorageService(root);
  await storage.init();
  const project = await storage.addProject(createProject("https://github.com/acme/repo.git"));
  const PR = "https://github.com/acme/repo/pull/1";
  await storage.addEnvironment({
    ...createEnvironment(project.id, { name: "feature" }),
    environmentType: "local",
    worktreePath: root,
    prUrl: PR,
    prState: "open",
    hasMergeConflicts: false,
    prMergeability: "clean",
  });
  let passed = true;
  let pending = false;
  const runner = spyOn(shell, "runCommand").mockImplementation(async (_name, args) => ({
    stdout: args!.includes(".permissions")
      ? '{"push":true}'
      : args!.includes("statusCheckRollup")
        ? JSON.stringify({
            statusCheckRollup: [
              {
                status: pending ? "IN_PROGRESS" : "COMPLETED",
                conclusion: passed ? "SUCCESS" : "FAILURE",
              },
            ],
          })
        : JSON.stringify({
            url: PR,
            state: "OPEN",
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
          }),
    stderr: "",
    exitCode: 0,
  }));
  let runtime: BackendRuntime | undefined;
  let model: NodeReadModel | undefined;
  let network: TestNodeNetwork | undefined;
  let previousGeneration: string | undefined;
  try {
    for (let restart = 0; restart < 2; restart += 1) {
      network = new TestNodeNetwork();
      const command = await network.add("command", { forceRegistration: true });
      const leaf = await network.add("leaf");
      const timers = new Map<object, () => void>();
      let now = 0;
      runtime = new BackendRuntime({
        emit: () => undefined,
        prMonitor: {
          timing: {
            schedule: (callback) => {
              const timer = {};
              timers.set(timer, callback);
              return timer;
            },
            cancel: (timer) => {
              timers.delete(timer as object);
            },
            monotonicNow: () => now,
            random: () => 0.5,
          },
        },
      });
      const context = { storage, runtime, emit: () => undefined } as unknown as CommandContext;
      const registry = createCommandRegistry();
      for (const name of ["get_projects", "get_environment_snapshots"]) {
        leaf.commands.set(name, (args) => registry.get(name)!(args, context));
      }
      // Deliberately relay only health hints: rollup transitions must refresh
      // even if no persisted environment fields change (or their event is missed).
      storage.setResourceChangeListener((change) => {
        if (change.resource === "environment-pr-health") leaf.emit("resource-changed", change);
      });
      await command.service.addNode({
        routes: [{ id: "primary" as never, kind: "https", enabled: true, origin: leaf.origin }],
        token: leaf.token,
      });
      model = new NodeReadModel({
        nodes: command.service,
        emit: () => undefined,
        fetchImpl: network.fetch,
        reconcileMs: 60_000,
        refreshDebounceMs: 0,
      });
      await model.start();
      await settle(40);
      const row = async () => (await model!.summaries()).nodes[0]!.environments[0]!;
      expect((await row()).prMonitorConfirmed).toBeUndefined();
      expect(timers.size).toBe(1);
      const generation = runtime.prMonitor.service.generation;
      expect(generation).not.toBe(previousGeneration);
      previousGeneration = generation;
      for (const check of ["failing", "passing", "pending", "passing", "failing"]) {
        passed = check === "passing";
        pending = check === "pending";
        now += 70_000; // Also makes the independently refreshed rollup due.
        const callbacks = [...timers.values()];
        timers.clear();
        callbacks.forEach((callback) => callback());
        for (let attempt = 0; attempt < 100; attempt += 1) {
          await settle(5);
          const current = await row();
          if (
            current.prCheckSummary?.passed === (passed ? 1 : 0) &&
            current.prCheckSummary?.pending === (pending ? 1 : 0)
          )
            break;
        }
        const current = await row();
        expect(current).toMatchObject({
          prMonitorConfirmed: true,
          prCheckSummary: { passed: passed ? 1 : 0, total: 1, pending: pending ? 1 : 0 },
        });
        expect(
          evaluatePrMergeReadiness({
            prState: current.prState,
            hasMergeConflicts: current.prHasMergeConflicts,
            mergeability: current.prMergeability,
            checkSummary: current.prCheckSummary ?? null,
            viewerCanMerge: current.prViewerCanMerge ?? null,
            fresh: current.prMonitorConfirmed === true,
          }).ready,
        ).toBe(passed);
      }
      expect(runtime.prMonitor.service.generation).toBe(generation);
      model.stop();
      model = undefined;
      runtime.shutdown();
      runtime = undefined;
      await network.stop();
      network = undefined;
      // Storage stays durable; the next iteration gets an entirely fresh runtime.
    }
  } finally {
    model?.stop();
    runtime?.shutdown();
    await network?.stop();
    runner.mockRestore();
    storage.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
