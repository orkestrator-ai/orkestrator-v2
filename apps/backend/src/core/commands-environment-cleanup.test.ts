import { emptyContainerLifecycle } from "@orkestrator/protocol/container-lifecycle";
import { readStoredValue, seedStore } from "./storage-test-support.js";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { fakePid } from "@orkestrator/protocol/testing/fake-pids";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCommandRegistry, type CommandContext } from "./commands.js";
import type { Environment } from "./models.js";
import { StorageService } from "./storage.js";
import {
  EnvironmentLifecycleTaskTracker,
  reconcileInterruptedEnvironmentLifecycleTasks,
} from "./environment-lifecycle-tasks.js";
import {
  closeEnvironmentCleanupStorage,
  ENVIRONMENT_CLEANUP_LEDGER_STORE,
  environmentCleanupLedger,
} from "./environment-cleanup-ledger.js";
import { StorageDatabase } from "./storage-database.js";
import { reconcileEnvironmentCleanup } from "./environment-cleanup-reconciler.js";
import { environmentStateDirectories } from "./environment-state-paths.js";
import { setupTerminalSessionId } from "./commands-terminal.js";
import type { PtyProcess } from "./pty.js";
import { runCommand } from "./shell.js";
import { dockerOwnerNamespace } from "./docker-ownership.js";
import { BackendRuntime } from "./backend-runtime.js";
import { deleteEnvironmentTask } from "./environment-delete.js";

import { projectHomeMailAttachmentDir } from "./mail-attachments.js";
import { transcriptMediaPins, TRANSCRIPT_MEDIA_PINS_DIRECTORY } from "./transcript-media-pins.js";

afterEach(() => closeEnvironmentCleanupStorage());

function environment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "e1",
    projectId: "p1",
    name: "Environment",
    branch: "main",
    containerId: null,
    status: "stopped",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
    ...overrides,
  };
}

async function withDeleteCommand<T>(
  seed: (storage: StorageService) => Promise<void>,
  run: (
    invokeDelete: () => Promise<void>,
    storage: StorageService,
    context: CommandContext,
  ) => Promise<T>,
): Promise<T> {
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(tmpdir(), "orkestrator-delete-state-")),
  );
  const worktreeDir = path.join(dataDir, "workspaces");
  const storage = new StorageService(dataDir);
  await storage.init();
  await seed(storage);
  const commands = createCommandRegistry();
  const context = {
    storage,
    appRoot: "",
    resourceRoot: "",
    toolchainBinDir: "",
    worktreeDir,
    environmentLifecycleTasks: new EnvironmentLifecycleTaskTracker(),
    runtime: new BackendRuntime({ emit: () => undefined }),
    emit: () => undefined,
  } as CommandContext;
  const invokeDelete = async () => {
    const command = commands.get("delete_environment");
    if (!command) throw new Error("delete_environment is not registered");
    await command({ environmentId: "e1" }, context);
  };
  try {
    return await run(invokeDelete, storage, context);
  } finally {
    context.runtime.shutdown();
    await context.runtime.diffStats.settled();
    await fs.chmod(worktreeDir, 0o700).catch(() => undefined);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

async function exists(target: string): Promise<boolean> {
  return fs.stat(target).then(
    () => true,
    () => false,
  );
}

/** A worktree leftover inside the workspaces root, with no project checkout. */
async function seedWorktree(storage: StorageService): Promise<string> {
  const worktreePath = path.join(storage.getDataDir(), "workspaces", "project-e1");
  await fs.mkdir(path.join(worktreePath, "bridges"), { recursive: true });
  await storage.addEnvironment(environment({ worktreePath }));
  return worktreePath;
}

describe("delete_environment host cleanup", () => {
  test("deletes the local branch in the deletion flow once its worktree is removed", async () => {
    let projectPath = "";
    let worktreePath = "";
    await withDeleteCommand(
      async (storage) => {
        projectPath = path.join(storage.getDataDir(), "project");
        worktreePath = path.join(storage.getDataDir(), "workspaces", "feature");
        await runCommand("git", ["init", "-b", "main", projectPath]);
        await runCommand("git", ["-C", projectPath, "config", "user.name", "Test"]);
        await runCommand("git", [
          "-C",
          projectPath,
          "config",
          "user.email",
          "test@example.invalid",
        ]);
        await fs.writeFile(path.join(projectPath, "readme"), "base");
        await runCommand("git", ["-C", projectPath, "add", "readme"]);
        await runCommand("git", ["-C", projectPath, "commit", "-m", "base"]);
        const base = (
          await runCommand("git", ["-C", projectPath, "rev-parse", "HEAD"])
        ).stdout.trim();
        await runCommand("git", [
          "-C",
          projectPath,
          "worktree",
          "add",
          "-b",
          "feature",
          worktreePath,
          base,
        ]);
        await storage.addProject({
          id: "p1",
          name: "Project",
          gitUrl: "https://example.invalid/p1.git",
          localPath: projectPath,
          addedAt: new Date(0).toISOString(),
          order: 0,
        });
        await storage.addEnvironment(
          environment({ branch: "feature", worktreePath, createdFromCommit: base }),
        );
      },
      async (invokeDelete, storage, context) => {
        await invokeDelete();
        expect(await exists(worktreePath)).toBe(false);
        await expect(
          runCommand("git", ["-C", projectPath, "show-ref", "--verify", "refs/heads/feature"]),
        ).rejects.toThrow();
        expect(await environmentCleanupLedger(storage.getDataDir()).list()).toEqual([]);
        const service = context.runtime.diffStats.service;
        await expect(service.readTree({ lookup: { worktreePath } })).rejects.toThrow(
          "being removed",
        );
        expect(await exists(worktreePath)).toBe(false);
        // The same project and branch allocate exactly the retired physical path.
        await runCommand("git", [
          "-C",
          projectPath,
          "worktree",
          "add",
          "-b",
          "feature",
          worktreePath,
          "main",
        ]);
        await storage.addEnvironment(
          environment({ id: "replacement", branch: "feature", worktreePath }),
        );
        await createCommandRegistry().get("start_environment")!(
          { environmentId: "replacement" },
          context,
        );
        expect((await storage.getEnvironment("replacement"))?.status).toBe("running");
        await storage.addEnvironment(
          environment({ id: "later", projectHome: true, worktreePath: projectPath }),
        );
        await context.runtime.diffStats.sync(context);
        expect(service.isTracked("replacement")).toBe(true);
        await service.readFileList({
          lookup: { worktreePath },
          comparisonRef: "HEAD",
          includeUncommitted: true,
        });
        await service.readTree({ lookup: { worktreePath } });
        // A later environment still reconciles; replacement tracking did not abort sync.
        expect(service.isTracked("later")).toBe(true);
      },
    );
  });

  test("deleting and re-ensuring a home leaves the retained checkout and its other owner readable", async () => {
    let checkout = "";
    await withDeleteCommand(
      async (storage) => {
        checkout = path.join(storage.getDataDir(), "checkout");
        await runCommand("git", ["init", "-b", "main", checkout]);
        await runCommand("git", ["-C", checkout, "config", "user.name", "Test"]);
        await runCommand("git", ["-C", checkout, "config", "user.email", "test@example.invalid"]);
        await fs.writeFile(path.join(checkout, "readme"), "fixture");
        await runCommand("git", ["-C", checkout, "add", "."]);
        await runCommand("git", ["-C", checkout, "commit", "-m", "fixture"]);
        await storage.addProject({
          id: "p1",
          name: "Project",
          gitUrl: "https://example.invalid/p1.git",
          localPath: checkout,
          addedAt: new Date(0).toISOString(),
          order: 0,
        });
        await storage.addEnvironment(environment({ projectHome: true, worktreePath: checkout }));
        await storage.addEnvironment(
          environment({ id: "other-owner", projectHome: true, worktreePath: checkout }),
        );
      },
      async (invokeDelete, storage, context) => {
        const tracking = context.runtime.diffStats;
        await tracking.sync(context);
        await invokeDelete();
        expect(await exists(checkout)).toBe(true);
        await tracking.service.readTree({ lookup: { worktreePath: checkout } });
        await tracking.service.readFileList({
          lookup: { worktreePath: checkout },
          comparisonRef: "HEAD",
          includeUncommitted: true,
        });
        expect(tracking.service.isTracked("other-owner")).toBe(true);
        // Remove only the second record, so ensure creates a fresh home at the retained root.
        await storage.removeEnvironment("other-owner");
        const home = (await createCommandRegistry().get("ensure_project_home_environment")!(
          { projectId: "p1" },
          context,
        )) as Environment;
        expect(home.worktreePath).toBe(checkout);
        expect(tracking.service.isTracked(home.id)).toBe(true);
        await tracking.sync(context);
        await tracking.service.readTree({ lookup: { worktreePath: checkout } });
      },
    );
  });

  test("a retained non-home checkout stays readable during deletion, failure, retry and ledger recovery", async () => {
    let worktreePath = "";
    let thirdPath = "";
    await withDeleteCommand(
      async (storage) => {
        worktreePath = await seedWorktree(storage);
        thirdPath = path.join(storage.getDataDir(), "third");
        for (const root of [worktreePath, thirdPath]) {
          await runCommand("git", ["init", "-b", "main", root]);
          await fs.writeFile(path.join(root, "file"), "fixture");
          await runCommand("git", ["-C", root, "add", "."]);
          await runCommand("git", [
            "-C",
            root,
            "-c",
            "user.name=Test",
            "-c",
            "user.email=t@e.invalid",
            "commit",
            "-m",
            "fixture",
          ]);
        }
        await storage.addEnvironment(environment({ id: "owner", worktreePath }));
        await storage.addEnvironment(environment({ id: "third", worktreePath: thirdPath }));
      },
      async (invokeDelete, storage, context) => {
        const tracking = context.runtime.diffStats;
        await tracking.sync(context);
        const reached = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const cleanup = spyOn(
          storage,
          "deleteMultiReviewWorkflowsByEnvironment",
        ).mockImplementationOnce(async () => {
          reached.resolve();
          await release.promise;
          throw new Error("cleanup interrupted");
        });
        const deleting = invokeDelete();
        const outcome = deleting.then(
          () => null,
          (error: unknown) => error,
        );
        const assertSurvivors = async () => {
          await tracking.sync(context);
          expect(tracking.service.isWatching("owner")).toBe(true);
          expect(tracking.service.isWatching("third")).toBe(true);
          await tracking.service.readTree({ lookup: { worktreePath } });
          await tracking.service.readFileList({
            lookup: { worktreePath },
            comparisonRef: "HEAD",
            includeUncommitted: true,
          });
          expect(await exists(worktreePath)).toBe(true);
        };
        try {
          await reached.promise;
          await assertSurvivors();
        } finally {
          release.resolve();
          const failure = await outcome;
          cleanup.mockRestore();
          expect(failure).toMatchObject({ message: "cleanup interrupted" });
        }
        const ledger = environmentCleanupLedger(storage.getDataDir());
        expect(await ledger.get("e1")).toMatchObject({ pending: ["state-dirs"] });
        await assertSurvivors();
        // Fail a later ledger step without changing the retained worktree.
        const finish = ledger.complete.bind(ledger);
        const complete = spyOn(ledger, "complete").mockImplementation(async (id, step) => {
          if (step === "state-dirs") throw new Error("ledger unavailable");
          await finish(id, step);
        });
        try {
          await invokeDelete();
        } finally {
          complete.mockRestore();
        }
        expect(await storage.getEnvironment("e1")).toBeNull();
        expect(await ledger.get("e1")).toMatchObject({ pending: ["state-dirs"] });
        await assertSurvivors();
        await reconcileEnvironmentCleanup(context, {
          now: () => new Date(Date.now() + 60 * 60_000),
        });
        expect(await ledger.get("e1")).toBeNull();
        await assertSurvivors();
      },
    );
  }, 30_000);

  test("runs the verified container step during deletion", async () => {
    await withDeleteCommand(
      async (storage) =>
        storage
          .addEnvironment(
            environment({ containerId: "test-container", environmentType: "containerized" }),
          )
          .then(() => undefined),
      async (invokeDelete, storage) => {
        const bin = path.join(storage.getDataDir(), "bin");
        await fs.mkdir(bin);
        const log = path.join(storage.getDataDir(), "docker-args");
        // The deletion verifies ownership before removing: answer the probe
        // as this registry's container.
        const owner = dockerOwnerNamespace(storage.getDataDir());
        await fs.writeFile(
          path.join(bin, "docker"),
          `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n` +
            `[ "$1" = inspect ] && printf '${owner}\\texited\\torkestrator-v2\\ttest-container\\n'\nexit 0\n`,
        );
        await fs.chmod(path.join(bin, "docker"), 0o700);
        const oldPath = process.env.PATH;
        process.env.PATH = `${bin}:${oldPath ?? ""}`;
        try {
          await invokeDelete();
        } finally {
          process.env.PATH = oldPath;
        }
        expect(await fs.readFile(log, "utf8")).toContain("rm -f test-container");
        expect(await environmentCleanupLedger(storage.getDataDir()).list()).toEqual([]);
      },
    );
  });

  test("keeps a deleting environment and worktree until a surviving terminal exits", async () => {
    let worktreePath = "";
    await withDeleteCommand(
      async (storage) => {
        worktreePath = await seedWorktree(storage);
      },
      async (invokeDelete, storage, context) => {
        let exited = false;
        const process = {
          pid: fakePid(1),
          onData: () => ({ dispose: () => undefined }),
          onExit: () => ({ dispose: () => undefined }),
          write: () => undefined,
          resize: () => undefined,
          kill: () => undefined,
          terminate: async () => exited,
        } satisfies PtyProcess;
        const id = setupTerminalSessionId("e1");
        context.runtime.terminals.registerProcess(id, process);
        try {
          await expect(invokeDelete()).rejects.toThrow("Terminal process trees are still running");
          expect(await exists(worktreePath)).toBe(true);
          // It says why, and keeps the tombstone a restart recovers from.
          const failed = await storage.getEnvironment("e1");
          expect(failed).toMatchObject({
            lifecycleOperation: "deleting",
            deletionRequestedAt: expect.any(String),
            deletionError: expect.stringContaining("Terminal process trees are still running"),
          });
          expect(await environmentCleanupLedger(storage.getDataDir()).get("e1")).toMatchObject({
            pending: ["worktree", "state-dirs"],
          });
          // A restart finds it and re-admits the same delete.
          expect(await reconcileInterruptedEnvironmentLifecycleTasks(storage)).toMatchObject({
            deletionRecoveryEnvironmentIds: ["e1"],
          });
          await fs.writeFile(path.join(worktreePath, "late-write"), "late");
          exited = true;
          // A retry clears the reason before it does anything else.
          let reasonDuringRetry: string | null | undefined = "unset";
          const stopServers = context.runtime.terminals.terminateSessionsForEnvironment.bind(
            context.runtime.terminals,
          );
          spyOn(context.runtime.terminals, "terminateSessionsForEnvironment").mockImplementation(
            async (environmentId) => {
              reasonDuringRetry = (await storage.getEnvironment("e1"))?.deletionError;
              return stopServers(environmentId);
            },
          );
          await invokeDelete();
          expect(reasonDuringRetry ?? null).toBeNull();
          expect(await exists(worktreePath)).toBe(false);
          expect(await storage.getEnvironment("e1")).toBeNull();
          expect(await environmentCleanupLedger(storage.getDataDir()).list()).toEqual([]);
        } finally {
          context.runtime.terminals.explicitlyCloseSession(id);
        }
      },
    );
  });

  test("records the step it is on as it reaches each one", async () => {
    await withDeleteCommand(
      async (storage) => {
        await seedWorktree(storage);
      },
      async (invokeDelete, storage) => {
        const steps: unknown[] = [];
        const update = storage.updateEnvironment.bind(storage);
        spyOn(storage, "updateEnvironment").mockImplementation(
          async (environmentId, updates, shouldUpdate) => {
            if ("deletionStep" in updates) steps.push(updates.deletionStep);
            return update(environmentId, updates, shouldUpdate);
          },
        );
        await invokeDelete();
        // No container, so no container step.
        expect(steps).toEqual([
          "stopping-work",
          "terminals",
          "workspace-files",
          "local-servers",
          "worktree",
          "records",
        ]);
        expect(await storage.getEnvironment("e1")).toBeNull();
      },
    );
  });

  test("Retry stays fenced after a confined helper is killed until its exit is delivered", async () => {
    await withDeleteCommand(
      async (storage) => {
        await seedWorktree(storage);
      },
      async (_invokeDelete, storage, context) => {
        const realSetTimeout = globalThis.setTimeout;
        // Fire the real stage deadline only after the removal helper starts.
        // No wall-clock race with Git startup is needed to reach this boundary.
        const deadlineMs = 123_456;
        let expire = () => {};
        const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
          ...timerArgs: Parameters<typeof setTimeout>
        ) => {
          const [handler, ms] = timerArgs;
          if (ms === deadlineMs)
            expire = () => {
              (handler as () => void)();
            };
          return realSetTimeout(...timerArgs);
        }) as typeof setTimeout);
        let releaseExit = () => {};
        let sawExit!: () => void;
        const exited = new Promise<void>((resolve) => {
          sawExit = resolve;
        });
        let exitSignal: unknown;
        // The boundary under test is acknowledgement of exit, not helper runtime.
        // A real helper can finish before the deadline microtask on a busy host.
        const spawnSpy = spyOn(childProcess, "spawn").mockImplementation((() => {
          const child = new EventEmitter();
          Object.assign(child, {
            pid: fakePid(2),
            kill: (signal: string) => {
              exitSignal = signal;
              releaseExit = () => {
                child.emit("exit", null, signal);
              };
              sawExit();
              return true;
            },
          });
          queueMicrotask(() => expire());
          return child as childProcess.ChildProcess;
        }) as typeof childProcess.spawn);
        let settled = false;
        const deleting = deleteEnvironmentTask("e1", context, {
          stepDeadlinesMs: { worktree: deadlineMs },
        })
          .catch((error: unknown) => error)
          .finally(() => {
            settled = true;
          });
        try {
          await exited;
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(exitSignal).toBe("SIGKILL");
          expect(settled).toBe(false);
          expect(context.runtime.environments.isDeleting("e1")).toBe(true);
          await expect(deleteEnvironmentTask("e1", context)).rejects.toThrow(
            "already being deleted",
          );
          releaseExit();
          expect(((await deleting) as Error).message).toContain(
            "Deletion stopped while removing the worktree",
          );
          expect(context.runtime.environments.isDeleting("e1")).toBe(false);
          expect(await storage.getEnvironment("e1")).toMatchObject({
            deletionStep: "worktree",
            deletionError: expect.stringContaining("Deletion stopped while removing the worktree"),
          });
        } finally {
          releaseExit();
          await deleting;
          spawnSpy.mockRestore();
          timerSpy.mockRestore();
        }
        // Once exit is delivered, the same delete is admitted and completes.
        await deleteEnvironmentTask("e1", context);
        expect(await storage.getEnvironment("e1")).toBeNull();
        expect(await environmentCleanupLedger(storage.getDataDir()).list()).toEqual([]);
      },
    );
  });

  test("a hung worktree removal is stopped at its deadline, says why, and a retry finishes it", async () => {
    if (process.platform === "win32") return;
    let worktreePath = "";
    await withDeleteCommand(
      async (storage) => {
        worktreePath = await seedWorktree(storage);
      },
      async (_invokeDelete, storage, context) => {
        // The worktree step's first command is `git fsmonitor--daemon stop`.
        // A git that never returns stands in for a child that hangs.
        const bin = path.join(storage.getDataDir(), "hanging-bin");
        const pidFile = path.join(storage.getDataDir(), "hanging-git.pid");
        await fs.mkdir(bin);
        await fs.writeFile(
          path.join(bin, "git"),
          `#!/bin/sh\nsleep 30 &\necho $$ > '${pidFile}'\nwait\n`,
          { mode: 0o755 },
        );
        // Expire only once the fixture has created its descendant. A real 300 ms
        // deadline can kill the leader during shell startup under aggregate load.
        const deadlineMs = 12_347;
        const realSetTimeout = globalThis.setTimeout;
        let expire = () => {};
        const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
          ...timerArgs: Parameters<typeof setTimeout>
        ) => {
          const [handler, ms] = timerArgs;
          if (ms === deadlineMs) expire = () => (handler as () => void)();
          return realSetTimeout(...timerArgs);
        }) as typeof setTimeout);
        const originalPath = process.env.PATH;
        process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
        // Exercise real capture cancellation, holding only its exit evidence.
        // Sending SIGKILL must not release the delete guard at either boundary.
        const realSpawn = Bun.spawn;
        const realKill = process.kill;
        let childPid = 0;
        let leaderHeld = true;
        let groupHeld = true;
        let sawGroupCheck!: () => void;
        const groupChecked = new Promise<void>((resolve) => {
          sawGroupCheck = resolve;
        });
        let sawKill!: () => void;
        const killed = new Promise<void>((resolve) => {
          sawKill = resolve;
        });
        let sawExit!: () => void;
        const exited = new Promise<void>((resolve) => {
          sawExit = resolve;
        });
        let releaseLeader!: () => void;
        const leaderGate = new Promise<void>((resolve) => {
          releaseLeader = resolve;
        });
        const spawnSpy = spyOn(Bun, "spawn").mockImplementation(((
          ...args: Parameters<typeof Bun.spawn>
        ) => {
          const child = realSpawn(...args);
          const argv = Array.isArray(args[0])
            ? args[0]
            : (args[0] as unknown as { cmd: string[] }).cmd;
          if (!argv.includes("fsmonitor--daemon") || !argv.includes(worktreePath)) return child;
          childPid = child.pid;
          const confirmed = child.exited.then(async (code) => {
            sawExit();
            await leaderGate;
            return code;
          });
          return new Proxy(child, {
            get(target, key) {
              if (key === "exited") return confirmed;
              if (leaderHeld && (key === "exitCode" || key === "signalCode")) return null;
              const value = Reflect.get(target, key);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        }) as typeof Bun.spawn);
        const killSpy = spyOn(process, "kill").mockImplementation((pid, signal) => {
          if (pid === -childPid && signal === "SIGKILL" && groupHeld) {
            // Simulate a descendant slow to stop: kill the actual leader now,
            // but keep its real sleep descendant alive until the test releases it.
            try {
              realKill(childPid, "SIGKILL");
            } catch {
              /* Leader already exited. */
            }
            sawKill();
            return true;
          }
          const result = realKill(pid, signal);
          if (pid === -childPid && signal === 0 && !leaderHeld && groupHeld) sawGroupCheck();
          return result;
        });
        const releaseGroup = () => {
          if (!groupHeld || !childPid) return;
          groupHeld = false;
          try {
            realKill(-childPid, "SIGKILL");
          } catch {
            /* Group already gone. */
          }
        };
        let settled = false;
        const deleting = deleteEnvironmentTask("e1", context, {
          stepDeadlinesMs: { worktree: deadlineMs },
        })
          .then(
            () => undefined,
            (caught: unknown) => caught,
          )
          .finally(() => {
            settled = true;
          });
        let error: unknown;
        try {
          for (let attempt = 0; attempt < 500 && !existsSync(pidFile); attempt++)
            await Bun.sleep(5);
          expect(existsSync(pidFile)).toBe(true);
          expire();
          await killed;
          await exited;
          expect(settled).toBe(false);
          expect(context.runtime.environments.isDeleting("e1")).toBe(true);
          await expect(deleteEnvironmentTask("e1", context)).rejects.toThrow(
            "already being deleted",
          );
          leaderHeld = false;
          releaseLeader();
          await groupChecked;
          expect(settled).toBe(false);
          await expect(deleteEnvironmentTask("e1", context)).rejects.toThrow(
            "already being deleted",
          );
          releaseGroup();
          error = await deleting;
        } finally {
          leaderHeld = false;
          releaseGroup();
          releaseLeader();
          await deleting;
          spawnSpy.mockRestore();
          killSpy.mockRestore();
          timerSpy.mockRestore();
          process.env.PATH = originalPath;
        }
        // The controlled deadline cancelled the capture, and the child is gone
        // by the time the delete reports it.
        expect((error as Error).message).toBe(
          "Deletion stopped while removing the worktree: it took longer than 1 min. Retry to continue.",
        );
        const pid = Number((await fs.readFile(pidFile, "utf8")).trim());
        expect(() => process.kill(pid, 0)).toThrow();
        expect(await exists(worktreePath)).toBe(true);
        expect(await storage.getEnvironment("e1")).toMatchObject({
          lifecycleOperation: "deleting",
          deletionStep: "worktree",
          deletionError: (error as Error).message,
        });
        expect(await environmentCleanupLedger(storage.getDataDir()).get("e1")).toMatchObject({
          pending: ["worktree", "state-dirs"],
          lastError: "worktree: deletion deadline passed",
        });

        // The delete settled, so a retry is admitted, and finishes it.
        await deleteEnvironmentTask("e1", context);
        expect(await storage.getEnvironment("e1")).toBeNull();
        expect(await exists(worktreePath)).toBe(false);
        expect(await environmentCleanupLedger(storage.getDataDir()).list()).toEqual([]);
      },
    );
  });

  test.each(["drain", "container", "volumes", "network", "success", "no-container-work"] as const)(
    "container stage deadline covers %s through the delete command",
    async (blocked) => {
      if (process.platform === "win32") return;
      await withDeleteCommand(
        async (storage) => {
          const lifecycle = emptyContainerLifecycle();
          if (blocked !== "no-container-work")
            lifecycle.storage.volumes = [{ name: "owned-volume", role: "workspace" }];
          await storage.addEnvironment(
            environment({
              // With volumes alone, ownsContainerWork must still enter the stage.
              containerId: ["drain", "container", "success"].includes(blocked)
                ? "owned-runtime"
                : null,
              environmentType:
                blocked === "volumes" || blocked === "no-container-work"
                  ? "local"
                  : "containerized",
              status: "running",
              containerLifecycle: lifecycle,
            }),
          );
        },
        async (_invokeDelete, storage, context) => {
          const bin = path.join(storage.getDataDir(), "docker-fixture-bin");
          const callsFile = path.join(storage.getDataDir(), "docker-calls.jsonl");
          const pidFile = path.join(storage.getDataDir(), "docker-pid");
          await fs.mkdir(bin);
          const owner = dockerOwnerNamespace(storage.getDataDir());
          await fs.writeFile(
            path.join(bin, "docker"),
            `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "exec" && !args.includes("/usr/local/bin/orkestrator-drain.sh")) { console.log("[]"); process.exit(0); }
const stage = args[0] === "exec" ? "drain" : args[0] === "rm" ? "container" : args[0] === "volume" ? "volumes" : args[0] === "network" ? "network" : "probe";
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ stage, args }) + "\\n");
if (stage === ${JSON.stringify(blocked)}) {
  fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
  setInterval(() => {}, 1000);
} else if (args[0] === "inspect") console.log(${JSON.stringify(owner)} + "\\trunning\\torkestrator-v2\\towned-runtime");
else if (args[0] === "exec") console.log("ORKESTRATOR_DRAIN signalled=0 remaining=0");
else if (args[1] === "inspect") console.log(JSON.stringify({ app: "orkestrator-v2", "orkestrator-owner": ${JSON.stringify(owner)}, "environment-id": "e1", "orkestrator-resource-role": "network" }) + (stage === "network" ? "\\t0" : ""));
`,
            { mode: 0o755 },
          );
          const originalPath = process.env.PATH;
          process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
          const deadlineMs = 1_234_567;
          const realTimeout = globalThis.setTimeout;
          let expire: (() => void) | undefined;
          // Drive the actual stage timer only once the intended child is live.
          // Other timers (capture, polling, background services) stay real.
          const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
            callback: () => void,
            delay?: number,
            ...args: unknown[]
          ) => {
            if (delay === deadlineMs) expire = callback;
            return realTimeout(callback, delay, ...args);
          }) as typeof setTimeout);
          let settled = false;
          const deleting = deleteEnvironmentTask("e1", context, {
            stepDeadlinesMs: { container: deadlineMs },
          })
            .then(
              () => null,
              (caught: unknown) => caught,
            )
            .finally(() => {
              settled = true;
            });
          try {
            if (blocked !== "success" && blocked !== "no-container-work") {
              const startupDeadline = Date.now() + 10_000;
              while (!(await exists(pidFile))) {
                if (settled || Date.now() > startupDeadline)
                  throw new Error("Docker fixture did not reach the intended stage");
                await Bun.sleep(10);
              }
              expect(expire).toBeFunction();
              expire!();
            }
            const error = await deleting;
            const calls = (await fs.readFile(callsFile, "utf8").catch(() => ""))
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line) as { stage: string; args: string[] });
            if (blocked === "success" || blocked === "no-container-work") {
              expect(error).toBeNull();
              expect(await storage.getEnvironment("e1")).toBeNull();
              expect(calls.map((call) => call.stage)).toEqual(
                blocked === "success"
                  ? [
                      "probe",
                      "drain",
                      "container",
                      "probe",
                      "volumes",
                      "volumes",
                      "network",
                      "network",
                    ]
                  : [],
              );
            } else {
              expect((error as Error).name).toBe("EnvironmentDeletionDeadlineError");
              expect(calls.at(-1)?.stage).toBe(blocked);
              const pid = Number(await fs.readFile(pidFile, "utf8"));
              expect(() => process.kill(pid, 0)).toThrow();
              expect(await storage.getEnvironment("e1")).toMatchObject({
                deletionStep: "container",
                deletionError: (error as Error).message,
              });
              const pending = (await environmentCleanupLedger(storage.getDataDir()).get("e1"))
                ?.pending;
              expect(pending).toContain(blocked === "drain" ? "container" : blocked);
            }
          } finally {
            if (!settled) expire?.();
            await deleting;
            timerSpy.mockRestore();
            process.env.PATH = originalPath;
          }
        },
      );
    },
    20_000,
  );

  test("stops watching and scanning the worktree before it removes it", async () => {
    let worktreePath = "";
    await withDeleteCommand(
      async (storage) => {
        worktreePath = await seedWorktree(storage);
      },
      async (invokeDelete, _storage, context) => {
        const service = context.runtime.diffStats.service;
        let worktreeAtPause = null as boolean | null;
        const pause = service.pause.bind(service);
        spyOn(service, "pause").mockImplementation((environmentId) => {
          if (environmentId === "e1") {
            worktreeAtPause = existsSync(worktreePath);
          }
          pause(environmentId);
        });
        await invokeDelete();
        expect(worktreeAtPause).toBe(true);
        expect(await exists(worktreePath)).toBe(false);
        expect(service.isTracked("e1")).toBe(false);
      },
    );
  });

  test("nothing re-creates the worktree after it is removed", async () => {
    let worktreePath = "";
    await withDeleteCommand(
      async (storage) => {
        worktreePath = await seedWorktree(storage);
        await fs.mkdir(path.join(worktreePath, "node_modules", "pkg"), { recursive: true });
        await fs.writeFile(path.join(worktreePath, "node_modules", "pkg", "index.js"), "");
      },
      async (invokeDelete, _storage, context) => {
        const tracking = context.runtime.diffStats;
        await tracking.sync(context);
        await invokeDelete();
        expect(await exists(worktreePath)).toBe(false);
        // A reconciliation or scan that arrives late has nothing left to act on.
        await tracking.sync(context);
        tracking.service.pause("e1");
        await Bun.sleep(20);
        expect(tracking.service.isTracked("e1")).toBe(false);
        expect(await exists(worktreePath)).toBe(false);
      },
    );
  });

  test.each(["tracked", "committed", "alternate-ref"] as const)(
    "waits for a %s read's exclude write before removing its worktree",
    async (mode) => {
      let worktreePath = "";
      await withDeleteCommand(
        async (storage) => {
          worktreePath = await seedWorktree(storage);
          await runCommand("git", ["init", worktreePath]);
        },
        async (invokeDelete, _storage, context) => {
          let reached!: () => void;
          const atWrite = new Promise<void>((resolve) => {
            reached = resolve;
          });
          let release!: () => void;
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          const mkdir = fs.mkdir.bind(fs);
          const intercepted = spyOn(fs, "mkdir").mockImplementation((async (
            ...args: Parameters<typeof fs.mkdir>
          ) => {
            if (String(args[0]) === path.join(worktreePath, ".git", "info")) {
              reached();
              await gate;
            }
            return mkdir(...args);
          }) as typeof fs.mkdir);
          const tracking = context.runtime.diffStats;
          let deleting: Promise<void> | undefined;
          let read: Promise<unknown> | undefined;
          try {
            if (mode === "tracked") {
              tracking.service.track({
                environmentId: "e1",
                kind: "local",
                worktreePath,
                comparisonRef: "HEAD",
              });
            } else {
              read = tracking.service.readFileList({
                lookup: { worktreePath },
                comparisonRef: mode === "alternate-ref" ? "other" : "HEAD",
                includeUncommitted: mode !== "committed",
              });
              // The empty Git fixture has no valid comparison; only the exclude write matters.
              void read.catch(() => undefined);
            }
            await atWrite;
            let paused!: () => void;
            const atPause = new Promise<void>((resolve) => {
              paused = resolve;
            });
            const pause = tracking.service.pause.bind(tracking.service);
            const pauseSpy = spyOn(tracking.service, "pause").mockImplementation((id) => {
              pause(id);
              paused();
            });
            try {
              deleting = invokeDelete();
              await atPause;
              await expect(
                tracking.service.readFileList({
                  lookup: { worktreePath },
                  comparisonRef: "HEAD",
                  includeUncommitted: false,
                }),
              ).rejects.toThrow("being removed");
              await expect(tracking.service.readTree({ lookup: { worktreePath } })).rejects.toThrow(
                "being removed",
              );
              // Pause cannot cancel mkdir/write work already admitted. Removal must wait.
              expect(await exists(worktreePath)).toBe(true);
              release();
              await deleting;
              await tracking.settled();
              expect(await exists(worktreePath)).toBe(false);
            } finally {
              pauseSpy.mockRestore();
            }
          } finally {
            release();
            await deleting;
            await read?.catch(() => undefined);
            tracking.shutdown();
            await tracking.settled();
            intercepted.mockRestore();
          }
        },
      );
    },
  );

  test("a delete that is stuck does not hold up another environment's", async () => {
    let stuckPath = "";
    let otherPath = "";
    await withDeleteCommand(
      async (storage) => {
        stuckPath = await seedWorktree(storage);
        otherPath = path.join(storage.getDataDir(), "workspaces", "project-e2");
        await fs.mkdir(otherPath, { recursive: true });
        await storage.addEnvironment(environment({ id: "e2", worktreePath: otherPath }));
      },
      async (invokeDelete, storage, context) => {
        let release!: () => void;
        const released = new Promise<boolean>((resolve) => {
          release = () => resolve(true);
        });
        let terminating!: () => void;
        const reachedTerminal = new Promise<void>((resolve) => {
          terminating = resolve;
        });
        const process = {
          pid: fakePid(1),
          onData: () => ({ dispose: () => undefined }),
          onExit: () => ({ dispose: () => undefined }),
          write: () => undefined,
          resize: () => undefined,
          kill: () => undefined,
          terminate: () => {
            terminating();
            return released;
          },
        } satisfies PtyProcess;
        const id = setupTerminalSessionId("e1");
        context.runtime.terminals.registerProcess(id, process);
        try {
          const stuck = invokeDelete();
          await reachedTerminal;
          const command = createCommandRegistry().get("delete_environment");
          await command?.({ environmentId: "e2" }, context);
          expect(await storage.getEnvironment("e2")).toBeNull();
          expect(await exists(otherPath)).toBe(false);
          // The stuck one is still there, tombstoned, with its worktree.
          expect(await storage.getEnvironment("e1")).toMatchObject({
            lifecycleOperation: "deleting",
          });
          expect(await exists(stuckPath)).toBe(true);
          release();
          await stuck;
          expect(await storage.getEnvironment("e1")).toBeNull();
          expect(await exists(stuckPath)).toBe(false);
        } finally {
          release();
          context.runtime.terminals.explicitlyCloseSession(id);
        }
      },
    );
  });

  test("removes the worktree and every bridge state directory", async () => {
    let worktreePath = "";
    await withDeleteCommand(
      async (storage) => {
        worktreePath = await seedWorktree(storage);
        for (const directory of environmentStateDirectories(storage.getDataDir(), "e1")) {
          await fs.mkdir(directory, { recursive: true });
          await fs.writeFile(path.join(directory, "checkpoints.ndjson"), "{}\n");
        }
      },
      async (invokeDelete, storage) => {
        await invokeDelete();
        expect(await storage.getEnvironment("e1")).toBeNull();
        expect(await exists(worktreePath)).toBe(false);
        for (const directory of environmentStateDirectories(storage.getDataDir(), "e1")) {
          expect(await exists(directory)).toBe(false);
        }
        expect(await environmentCleanupLedger(storage.getDataDir()).list()).toEqual([]);
      },
    );
  });

  test("keeps a failed worktree removal in the ledger and the reconciler finishes it", async () => {
    // Root ignores directory permissions, so the failure cannot be staged.
    if (process.getuid?.() === 0) return;
    let worktreePath = "";
    await withDeleteCommand(
      async (storage) => {
        worktreePath = await seedWorktree(storage);
      },
      async (invokeDelete, storage, context) => {
        const workspaces = path.dirname(worktreePath);
        await fs.chmod(workspaces, 0o500);
        await invokeDelete();
        // The environment record is still removed on time.
        expect(await storage.getEnvironment("e1")).toBeNull();
        expect(await exists(worktreePath)).toBe(true);
        const ledger = environmentCleanupLedger(storage.getDataDir());
        expect(await ledger.get("e1")).toMatchObject({ pending: ["worktree"] });
        const service = context.runtime.diffStats.service;
        const target = {
          environmentId: "replacement",
          kind: "local" as const,
          worktreePath,
          comparisonRef: "HEAD",
        };
        expect(() => service.track(target)).toThrow("being removed");
        await expect(service.readTree({ lookup: { worktreePath } })).rejects.toThrow(
          "being removed",
        );

        await fs.chmod(workspaces, 0o700);
        const later = new Date(Date.now() + 60 * 60_000);
        await reconcileEnvironmentCleanup(context, { now: () => later });
        expect(await exists(worktreePath)).toBe(false);
        expect(await ledger.get("e1")).toBeNull();
        await expect(service.readTree({ lookup: { worktreePath } })).rejects.toThrow(
          "being removed",
        );
        await fs.mkdir(worktreePath);
        await runCommand("git", ["init", worktreePath]);
        service.track(target);
        await service.readTree({ lookup: { worktreePath } });
      },
    );
  });

  test("records cleanup before removing anything, and keeps the environment if it cannot", async () => {
    let worktreePath = "";
    await withDeleteCommand(
      async (storage) => {
        worktreePath = await seedWorktree(storage);
      },
      async (invokeDelete, storage) => {
        // The ledger's commit fails at the database write boundary.
        const realWrite = StorageDatabase.prototype.writeStoreInTransaction;
        const write = spyOn(
          StorageDatabase.prototype,
          "writeStoreInTransaction",
        ).mockImplementation(function (this: StorageDatabase, store, ...rest) {
          if (store === ENVIRONMENT_CLEANUP_LEDGER_STORE) throw new Error("disk I/O error");
          return realWrite.call(this, store, ...rest);
        });
        try {
          await expect(invokeDelete()).rejects.toThrow();
        } finally {
          write.mockRestore();
        }
        expect(await exists(worktreePath)).toBe(true);
        expect(await storage.getEnvironment("e1")).toMatchObject({
          id: "e1",
          deletionRequestedAt: expect.any(String),
        });
        expect(await environmentCleanupLedger(storage.getDataDir()).list()).toEqual([]);
      },
    );
  });
});

describe("delete_environment durable child-state cleanup", () => {
  test("removes transcript media pins only for the deleted environment", async () => {
    await withDeleteCommand(
      async (storage) => {
        await storage.addEnvironment(environment());
      },
      async (invokeDelete, storage) => {
        const pins = transcriptMediaPins(storage.getDataDir());
        const identity = {
          environmentId: "e1",
          logicalSessionKey: "tab",
          messageId: "m1",
          reference: "shot.png",
        };
        const read = async () => ({ bytes: Buffer.from("private image") });
        await pins.pin(identity, read);
        await pins.pin({ ...identity, environmentId: "e2" }, read);
        const root = path.join(storage.getDataDir(), TRANSCRIPT_MEDIA_PINS_DIRECTORY);
        expect(await fs.readdir(root)).toHaveLength(2);
        await invokeDelete();
        expect(await storage.getEnvironment("e1")).toBeNull();
        expect(await fs.readdir(root)).toHaveLength(1);
        expect((await pins.pin(identity, read)).status).toBe("live");
        expect((await pins.pin({ ...identity, environmentId: "e2" }, read)).status).toBe("pinned");
      },
    );
  });

  test("pin cleanup failures are reported without stranding environment deletion", async () => {
    await withDeleteCommand(
      async (storage) => {
        await storage.addEnvironment(environment());
      },
      async (invokeDelete, storage) => {
        const pins = transcriptMediaPins(storage.getDataDir());
        const cleanup = spyOn(pins, "deleteEnvironment").mockRejectedValue(
          new Error("private failure detail"),
        );
        const warning = spyOn(console, "warn").mockImplementation(() => undefined);
        try {
          await expect(invokeDelete()).resolves.toBeUndefined();
          expect(cleanup).toHaveBeenCalledWith("e1");
          expect(warning).toHaveBeenCalledWith(
            expect.stringContaining(
              "delete.step-failed environmentId=e1 step=transcript-media-pins",
            ),
          );
          expect(await storage.getEnvironment("e1")).toBeNull();
        } finally {
          cleanup.mockRestore();
          warning.mockRestore();
        }
      },
    );
  });

  test("records its change-tracking purge, and a failure does not strand deletion", async () => {
    await withDeleteCommand(
      async (storage) => {
        await storage.addEnvironment(environment());
      },
      async (invokeDelete, storage, context) => {
        const environmentDeleted = mock((_environmentId: string): void => {
          throw new Error("private failure detail");
        });
        context.runtime.changeTracking = {
          environmentDeleted,
          onDiffScanEvent: () => undefined,
        } as unknown as NonNullable<typeof context.runtime.changeTracking>;
        const warning = spyOn(console, "warn").mockImplementation(() => undefined);
        try {
          await expect(invokeDelete()).resolves.toBeUndefined();
          expect(environmentDeleted).toHaveBeenCalledWith("e1");
          expect(warning).toHaveBeenCalledWith(
            expect.stringContaining("delete.step-failed environmentId=e1 step=change-tracking"),
          );
          expect(await storage.getEnvironment("e1")).toBeNull();
        } finally {
          context.runtime.changeTracking = null;
          warning.mockRestore();
        }
      },
    );
  });

  test("releases the native projection caches of its sessions after their records go", async () => {
    await withDeleteCommand(
      async (storage) => storage.addEnvironment(environment()).then(() => undefined),
      async (invokeDelete, storage, context) => {
        const order: string[] = [];
        const deleteSessions = storage.deleteNativeAgentSessionsByEnvironment.bind(storage);
        storage.deleteNativeAgentSessionsByEnvironment = async (environmentId: string) => {
          order.push("session-records");
          return deleteSessions(environmentId);
        };
        const forgetEnvironmentProjections = mock((_environmentId: string) => {
          order.push("projection-caches");
        });
        context.nativeAgents = {
          forgetEnvironmentCommandCatalogues: () => undefined,
          forgetEnvironmentProjections,
        } as unknown as NonNullable<typeof context.nativeAgents>;

        await invokeDelete();
        expect(forgetEnvironmentProjections).toHaveBeenCalledWith("e1");
        expect(order).toEqual(["session-records", "projection-caches"]);
        expect(await storage.getEnvironment("e1")).toBeNull();
      },
    );
  });

  test("purges agent mail before removing the environment", async () => {
    await withDeleteCommand(
      async (storage) => storage.addEnvironment(environment()).then(() => undefined),
      async (invokeDelete, storage) => {
        const original = storage.deleteAgentMailByEnvironment.bind(storage);
        const purge = mock(async (environmentId: string) => original(environmentId));
        storage.deleteAgentMailByEnvironment = purge;

        await invokeDelete();
        expect(purge).toHaveBeenCalledWith("e1");
        expect(await storage.getEnvironment("e1")).toBeNull();
      },
    );
  });

  test("removes the images mailed to a project home, and leaves its checkout alone", async () => {
    await withDeleteCommand(
      async (storage) => {
        const checkout = path.join(storage.getDataDir(), "checkout");
        await fs.mkdir(checkout);
        await storage.addEnvironment(environment({ projectHome: true, worktreePath: checkout }));
      },
      async (invokeDelete, storage) => {
        const images = projectHomeMailAttachmentDir(storage.getDataDir(), "e1", "a".repeat(32));
        await fs.mkdir(images, { recursive: true });
        await fs.writeFile(path.join(images, "shot.png"), "image");

        await invokeDelete();
        expect(await storage.getEnvironment("e1")).toBeNull();
        expect(await exists(projectHomeMailAttachmentDir(storage.getDataDir(), "e1"))).toBe(false);
        expect(await exists(path.join(storage.getDataDir(), "checkout"))).toBe(true);
      },
    );
  });

  test("revokes the environment's project-scoped agent-tools credential", async () => {
    await withDeleteCommand(
      async (storage) => storage.addEnvironment(environment()).then(() => undefined),
      async (invokeDelete, storage, context) => {
        const revokeEnvironment = mock(() => undefined);
        context.agentTools = {
          connection: mock(() => ({
            url: "http://127.0.0.1:43210/mcp",
            token: "test-token",
          })),
          revokeEnvironment,
        };

        await invokeDelete();
        expect(revokeEnvironment).toHaveBeenCalledWith("e1");
        expect(await storage.getEnvironment("e1")).toBeNull();
      },
    );
  });

  test("deletes the environment even when a native session record is unreadable", async () => {
    await withDeleteCommand(
      async (storage) => {
        await storage.addEnvironment(environment());
        // A record written by a newer build. Nothing in this delete path can
        // read it, and refusing to finish here would strand the environment
        // itself — leaving the user no way to clear the record at all.
        seedStore(storage.getDataDir(), "native-agent-sessions.json", {
          "poisoned-key": {
            version: 2,
            key: "poisoned-key",
            environmentId: "e2",
            agent: "codex",
            logicalSessionKey: "env-e2:tab-1",
            providerSessionId: "future-provider-session",
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
          },
        });
      },
      async (invokeDelete, storage) => {
        await expect(invokeDelete()).resolves.toBeUndefined();
        expect(await storage.getEnvironment("e1")).toBeNull();
        const remaining = readStoredValue<Record<string, unknown>>(
          storage.getDataDir(),
          "native-agent-sessions.json",
        );
        expect(remaining?.["poisoned-key"]).toMatchObject({ version: 2 });
      },
    );
  });

  test("retains a deleting environment when pipeline cleanup fails", async () => {
    await withDeleteCommand(
      async (storage) => storage.addEnvironment(environment()).then(() => undefined),
      async (invokeDelete, storage) => {
        const original = storage.deleteBuildPipelinesByEnvironment.bind(storage);
        storage.deleteBuildPipelinesByEnvironment = mock(async () => {
          throw new Error("pipeline cleanup failed");
        });

        await expect(invokeDelete()).rejects.toThrow("pipeline cleanup failed");
        expect(await storage.getEnvironment("e1")).toMatchObject({
          id: "e1",
          deletionRequestedAt: expect.any(String),
        });

        storage.deleteBuildPipelinesByEnvironment = original;
        await expect(invokeDelete()).resolves.toBeUndefined();
        expect(await storage.getEnvironment("e1")).toBeNull();
      },
    );
  });

  test("retains a deleting environment when prompt cleanup fails", async () => {
    await withDeleteCommand(
      async (storage) => storage.addEnvironment(environment()).then(() => undefined),
      async (invokeDelete, storage) => {
        const original = storage.deletePromptQueuesByEnvironment.bind(storage);
        storage.deletePromptQueuesByEnvironment = mock(async () => {
          throw new Error("prompt cleanup failed");
        });

        await expect(invokeDelete()).rejects.toThrow("prompt cleanup failed");
        expect(await storage.getEnvironment("e1")).toMatchObject({
          id: "e1",
          deletionRequestedAt: expect.any(String),
        });

        storage.deletePromptQueuesByEnvironment = original;
        await expect(invokeDelete()).resolves.toBeUndefined();
        expect(await storage.getEnvironment("e1")).toBeNull();
      },
    );
  });

  test("retains a deleting environment when handoff cleanup fails", async () => {
    await withDeleteCommand(
      async (storage) => storage.addEnvironment(environment()).then(() => undefined),
      async (invokeDelete, storage) => {
        const original = storage.deleteAgentHandoffsByEnvironment.bind(storage);
        storage.deleteAgentHandoffsByEnvironment = mock(async () => {
          throw new Error("handoff cleanup failed");
        });

        await expect(invokeDelete()).rejects.toThrow("handoff cleanup failed");
        expect(await storage.getEnvironment("e1")).toMatchObject({
          id: "e1",
          deletionRequestedAt: expect.any(String),
        });

        storage.deleteAgentHandoffsByEnvironment = original;
        await expect(invokeDelete()).resolves.toBeUndefined();
        expect(await storage.getEnvironment("e1")).toBeNull();
      },
    );
  });

  test("deletes the environment-linked pipeline whose stored environment id is blank", async () => {
    await withDeleteCommand(
      async (storage) => {
        await storage.saveBuildPipeline("pipeline-1", "p1", "", 1, { id: "pipeline-1" });
        await storage.addEnvironment(environment({ buildPipelineId: "pipeline-1" }));
      },
      async (invokeDelete, storage) => {
        await invokeDelete();
        expect(await storage.getBuildPipeline("pipeline-1")).toBeNull();
      },
    );
  });

  test("deleting a sidebar fork keeps the source's pipeline", async () => {
    await withDeleteCommand(
      async (storage) => {
        // The sidebar's Fork copies the source's buildPipelineId onto e1.
        await storage.addEnvironment(
          environment({ id: "source", buildPipelineId: "pipeline-1", order: 1 }),
        );
        await storage.saveBuildPipeline("pipeline-1", "p1", "source", 1, { id: "pipeline-1" });
        await storage.addEnvironment(environment({ buildPipelineId: "pipeline-1" }));
        await storage.saveBuildPipeline("fork-pipeline", "p1", "e1", 1, { id: "fork-pipeline" });
      },
      async (invokeDelete, storage) => {
        await invokeDelete();
        expect(await storage.getEnvironment("e1")).toBeNull();
        expect(await storage.getBuildPipeline("fork-pipeline")).toBeNull();
        expect(await storage.getBuildPipeline("pipeline-1")).toMatchObject({
          environmentId: "source",
        });
      },
    );
  });

  test("rejects delayed saves once deletion is marked and then sweeps older saves", async () => {
    await withDeleteCommand(
      async (storage) => {
        await storage.addEnvironment(environment({ buildPipelineId: "pipeline-1" }));
        await storage.saveBuildPipeline("pipeline-1", "p1", "e1", 1, { id: "pipeline-1" });
        await storage.savePromptQueue("claude env-e1:tab-1", "e1", [{ id: "m1" }]);
        await storage.saveAgentHandoff("handoff-1", "e1", 1, { messages: [{ id: "m1" }] });
      },
      async (invokeDelete, storage) => {
        let releaseCleanup!: () => void;
        let cleanupStarted!: () => void;
        const gate = new Promise<void>((resolve) => {
          releaseCleanup = resolve;
        });
        const started = new Promise<void>((resolve) => {
          cleanupStarted = resolve;
        });
        const original = storage.deleteBuildPipelinesByEnvironment.bind(storage);
        storage.deleteBuildPipelinesByEnvironment = async (environmentId, linkedPipelineId) => {
          cleanupStarted();
          await gate;
          return original(environmentId, linkedPipelineId);
        };

        const deletion = invokeDelete();
        await started;
        await expect(
          storage.savePromptQueue("claude env-e1:tab-1", "e1", [{ id: "late" }]),
        ).rejects.toThrow("being deleted");
        await expect(
          storage.saveBuildPipeline("pipeline-1", "p1", "e1", 1, {
            id: "pipeline-1",
            phase: "late",
          }),
        ).rejects.toThrow("being deleted");
        await expect(
          storage.saveAgentHandoff("handoff-late", "e1", 1, { messages: [] }),
        ).rejects.toThrow("being deleted");

        releaseCleanup();
        await deletion;
        expect(await storage.getEnvironment("e1")).toBeNull();
        expect(await storage.getBuildPipeline("pipeline-1")).toBeNull();
        expect(await storage.getPromptQueue("claude env-e1:tab-1")).toBeNull();
        expect(await storage.getAgentHandoff("handoff-1")).toBeNull();
      },
    );
  });
});

test("deletion waits for user command termination before clearing prompts or deleting state", async () => {
  await withDeleteCommand(
    async (storage) => {
      await seedWorktree(storage);
    },
    async (remove, storage, context) => {
      const terminate = mock<() => Promise<void>>(async () => {
        throw new Error("termination unconfirmed");
      });
      const clear = mock(() => undefined);
      context.userCommands = {
        terminateForEnvironment: terminate,
      } as unknown as CommandContext["userCommands"];
      context.humanPrompts = {
        clearEnvironment: clear,
      } as unknown as CommandContext["humanPrompts"];
      await expect(remove()).rejects.toThrow("termination unconfirmed");
      expect(terminate).toHaveBeenCalledWith("e1");
      expect(clear).not.toHaveBeenCalled();
      expect(await storage.getEnvironment("e1")).not.toBeNull();
      terminate.mockImplementation(async () => undefined);
      await remove();
      expect(clear).toHaveBeenCalledWith("e1");
      expect(await storage.getEnvironment("e1")).toBeNull();
    },
  );
});
