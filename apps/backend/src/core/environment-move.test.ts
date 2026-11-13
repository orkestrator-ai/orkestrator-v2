// Moving an environment's worktree: the move command, interrupted-move recovery and failure boundaries.
import { describe, expect, test, spyOn, setDefaultTimeout } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  AGENT_ACTIVE_MOVE_ERROR,
  moveEnvironmentTask,
  recoverInterruptedEnvironmentMoves,
} from "./environment-move.js";
import { claudeProjectSlug, codexCwdHash } from "./environment-move-sessions.js";
import { EnvironmentMutationFence } from "./environment-replacement-fence.js";
import type { Environment } from "./models.js";
import { runCommand } from "./shell.js";
import * as shell from "./shell.js";
import * as tmux from "./tmux-commands.js";
import { TmuxBackend } from "./tmux-backend.js";
import { claudeTmuxRuntimeRootPrefix, tmuxSessionName } from "./tmux-shared.js";
import { realTmux, withPrivateTmux } from "../../tests/tmux-lifecycle-fixture.js";
import { StorageService } from "./storage.js";
import {
  listTmuxSessions,
  setup,
  addNestedSubmodules,
  expectSubmodulesLinked,
  registeredWorktrees,
  isolatedHomes,
  exists,
  registerEnvironmentMoveFixtureHooks,
} from "./environment-move-test-support.js";

// This slow-tier file creates real repositories/worktrees and waits for
// subprocess cleanup. Give that fixture work its own bounded host budget;
// explicit operation deadlines and shorter test budgets remain unchanged.
setDefaultTimeout(30_000);
registerEnvironmentMoveFixtureHooks();

describe("move_environment", () => {
  test("distinguishes an unconfigured checkout from a missing checkout", async () => {
    const { root, projectPath, storage, context, startLocal } = await setup();
    const environment = await startLocal();
    await storage.updateProject(environment.projectId, { localPath: null });
    await expect(
      moveEnvironmentTask(environment.id, path.join(root, "moved"), context),
    ).rejects.toThrow("This project has no local checkout configured, so the worktree can't move");
    const missing = path.join(root, "missing");
    await storage.updateProject(environment.projectId, { localPath: missing });
    await expect(
      moveEnvironmentTask(environment.id, path.join(root, "moved"), context),
    ).rejects.toThrow(
      `The project's local checkout does not exist: ${missing} on ${os.hostname()}`,
    );
    expect(await fs.stat(projectPath)).toBeTruthy();
    expect((await storage.getEnvironment(environment.id))?.worktreePath).toBe(
      environment.worktreePath,
    );
    expect((await storage.getEnvironment(environment.id))?.worktreeMove).toBeFalsy();
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports a checkout under an inaccessible parent as a permission problem",
    async () => {
      const { root, storage, context, startLocal } = await setup();
      const environment = await startLocal();
      const parent = path.join(root, "locked");
      const checkout = path.join(parent, "checkout");
      await fs.mkdir(checkout, { recursive: true });
      await storage.updateProject(environment.projectId, { localPath: checkout });
      await fs.chmod(parent, 0o000);
      try {
        await expect(
          moveEnvironmentTask(environment.id, path.join(root, "moved"), context),
        ).rejects.toThrow(
          `Orkestrator does not have permission to open the project's local checkout: ${checkout} on ${os.hostname()}`,
        );
      } finally {
        await fs.chmod(parent, 0o700);
      }
      expect((await storage.getEnvironment(environment.id))?.worktreePath).toBe(
        environment.worktreePath,
      );
      expect((await storage.getEnvironment(environment.id))?.worktreeMove).toBeFalsy();
    },
  );

  test("moves with no tmux sessions or hook backups and preserves workspace settings", async () => {
    const { root, storage, context, startLocal } = await setup();
    const environment = await startLocal();
    const settings = JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } });
    await fs.mkdir(path.join(environment.worktreePath!, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(environment.worktreePath!, ".claude", "settings.local.json"),
      settings,
    );

    const originalRun = shell.runCommand;
    const stops: string[][] = [];
    spyOn(shell, "runCommand").mockImplementation(async (command, args = [], options) => {
      if (args.includes("fsmonitor--daemon")) {
        stops.push(args);
        expect(await exists(environment.worktreePath!)).toBe(true);
        expect(await exists(path.join(root, "moved"))).toBe(false);
      }
      return originalRun(command, args, options);
    });
    const moved = await moveEnvironmentTask(environment.id, path.join(root, "moved"), context, {
      sessionHomes: isolatedHomes(root),
    });

    expect(stops).toEqual([
      ["-C", environment.worktreePath!, "-c", "core.fsmonitor=false", "fsmonitor--daemon", "stop"],
    ]);
    expect(listTmuxSessions).toHaveBeenCalledTimes(1);
    expect(await exists(environment.worktreePath!)).toBe(false);
    expect((await storage.getEnvironment(environment.id))?.worktreePath).toBe(moved.worktreePath);
    expect(
      await fs.readFile(path.join(moved.worktreePath!, ".claude", "settings.local.json"), "utf8"),
    ).toBe(settings);
  });

  for (const forceCopy of [false, true]) {
    test(`moves every file and re-points git (${forceCopy ? "copy" : "rename"})`, async () => {
      const { root, projectPath, storage, context, startLocal } = await setup();
      const environment = await startLocal();
      const from = environment.worktreePath!;
      await fs.writeFile(path.join(from, "untracked.txt"), "work in progress");
      await fs.mkdir(path.join(from, "node_modules", "dep"), { recursive: true });
      await fs.writeFile(path.join(from, "node_modules", "dep", "index.js"), "ignored");
      await fs.symlink("README.md", path.join(from, "readme-link"));
      const destination = path.join(root, "elsewhere");

      const homes = {
        claudeConfigDir: path.join(root, "claude-home"),
        claudeJsonPath: path.join(root, "claude.json"),
        codexHomes: [path.join(root, "codex-home")],
        cursorStateDir: path.join(root, "cursor-state"),
      };
      const oldTranscripts = path.join(homes.claudeConfigDir, "projects", claudeProjectSlug(from));
      await fs.mkdir(oldTranscripts, { recursive: true });
      await fs.writeFile(path.join(oldTranscripts, "session-1.jsonl"), "{}\n");
      const codexState = path.join(homes.codexHomes[0]!, "orkestrator-bridge");
      await fs.mkdir(path.join(codexState, `bridge-sessions-${codexCwdHash(from)}`), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(codexState, `bridge-sessions-${codexCwdHash(from)}`, "r.json"),
        JSON.stringify({ bridgeSessionId: "b", threadId: "t", cwdHash: codexCwdHash(from) }),
      );

      const moved = await moveEnvironmentTask(environment.id, destination, context, {
        forceCopy,
        sessionHomes: homes,
      });

      const to = path.join(destination, path.basename(from));
      expect(moved.worktreePath).toBe(to);
      expect(moved.worktreeBaseDir).toBe(destination);
      expect(moved.lifecycleOperation).toBeUndefined();
      expect(moved.worktreeMove).toBeUndefined();
      expect(await exists(from)).toBe(false);
      expect(await fs.readFile(path.join(to, "untracked.txt"), "utf8")).toBe("work in progress");
      expect(await fs.readFile(path.join(to, "node_modules", "dep", "index.js"), "utf8")).toBe(
        "ignored",
      );
      expect(await fs.readlink(path.join(to, "readme-link"))).toBe("README.md");
      expect(await registeredWorktrees(projectPath)).toContain(to);
      expect(await registeredWorktrees(projectPath)).not.toContain(from);
      const { stdout: branch } = await runCommand("git", ["-C", to, "branch", "--show-current"]);
      expect(branch.trim()).toBe(environment.branch);
      const { stdout: status } = await runCommand("git", ["-C", to, "status", "--porcelain"]);
      expect(status).toContain("untracked.txt");
      expect((await storage.getEnvironment(environment.id))?.worktreePath).toBe(to);
      // Agents resume the environment's conversations from the new folder.
      const newTranscripts = path.join(homes.claudeConfigDir, "projects", claudeProjectSlug(to));
      expect(await fs.readFile(path.join(newTranscripts, "session-1.jsonl"), "utf8")).toContain(
        `"relocatedCwd":${JSON.stringify(to)}`,
      );
      const record = JSON.parse(
        await fs.readFile(
          path.join(codexState, `bridge-sessions-${codexCwdHash(to)}`, "r.json"),
          "utf8",
        ),
      ) as { cwdHash: string };
      expect(record.cwdHash).toBe(codexCwdHash(to));
    });
  }

  for (const forceCopy of [false, true]) {
    test(`moves a worktree with nested submodules (${forceCopy ? "copy" : "same disk"})`, async () => {
      const { root, projectPath, storage, context, startLocal } = await setup();
      const environment = await startLocal();
      const from = environment.worktreePath!;
      await addNestedSubmodules(root, projectPath, from);
      const destination = path.join(root, "deeper", "elsewhere");

      const moved = await moveEnvironmentTask(environment.id, destination, context, {
        forceCopy,
        sessionHomes: isolatedHomes(root),
      });

      const to = path.join(destination, path.basename(from));
      expect(moved.worktreePath).toBe(to);
      expect(moved.lifecycleError).toBeFalsy();
      expect(moved.worktreeMove).toBeUndefined();
      expect(await exists(from)).toBe(false);
      expect(await registeredWorktrees(projectPath)).toContain(to);
      expect(await registeredWorktrees(projectPath)).not.toContain(from);
      await expectSubmodulesLinked(to);
      expect((await storage.getEnvironment(environment.id))?.worktreePath).toBe(to);
    });
  }

  test("a failed submodule re-link restores the original checkout", async () => {
    const { root, projectPath, storage, context, startLocal } = await setup();
    const environment = await startLocal();
    const from = environment.worktreePath!;
    await addNestedSubmodules(root, projectPath, from);
    const run = shell.runCommand;
    let configWrites = 0;
    spyOn(shell, "runCommand").mockImplementation(async (command, args, options) => {
      if (command === "git" && args?.[0] === "config" && args.includes("core.worktree")) {
        // Fail part-way through re-linking the copy; the rollback re-links the source.
        if (++configWrites === 2) throw new Error("config write failed");
      }
      return run(command, args, options);
    });
    const destination = path.join(root, "elsewhere");
    await expect(
      moveEnvironmentTask(environment.id, destination, context, {
        forceCopy: true,
        sessionHomes: isolatedHomes(root),
      }),
    ).rejects.toThrow("config write failed");
    expect(await fs.readdir(destination)).toEqual([]);
    const current = (await storage.getEnvironment(environment.id))!;
    expect(current.worktreePath).toBe(from);
    expect(current.worktreeMove).toBeUndefined();
    expect(await registeredWorktrees(projectPath)).toContain(from);
    await expectSubmodulesLinked(from);
  });

  for (const live of [false, true]) {
    test.skipIf(!realTmux)(
      `move with an absent socket (${live ? "live unlinked server" : "never started"})`,
      async () => {
        const { root, storage, context, startLocal } = await setup();
        const environment = await startLocal();
        const from = environment.worktreePath!;
        const destination = path.join(root, "elsewhere");
        const runtimeRoot = path.join(
          claudeTmuxRuntimeRootPrefix(storage.getDataDir()),
          environment.id,
        );
        const attribution = path.join(runtimeRoot, "sessions", "saved-session");
        await fs.mkdir(attribution, { recursive: true });
        await withPrivateTmux(async (fixture) => {
          if (live) {
            await fixture.start(tmuxSessionName(environment.id, "tab-live"), from);
            await fs.unlink(fixture.socket);
            expect(fixture.alive()).toBe(true);
          }
          const exec = TmuxBackend.prototype.exec;
          spyOn(TmuxBackend.prototype, "exec").mockImplementation(function (
            this: TmuxBackend,
            ...args
          ) {
            return args[0][0] === "tmux" || args[0][0] === "ps"
              ? fixture.exec(args[0])
              : exec.apply(this, args);
          });
          try {
            if (live) {
              await expect(
                moveEnvironmentTask(environment.id, destination, context, {
                  sessionHomes: isolatedHomes(root),
                }),
              ).rejects.toThrow("cleanup incomplete");
              expect((await storage.getEnvironment(environment.id))?.worktreePath).toBe(from);
              expect(await exists(from)).toBe(true);
              expect(await exists(path.join(destination, path.basename(from)))).toBe(false);
              expect(await exists(attribution)).toBe(true);
              expect(fixture.alive()).toBe(true);
              await fixture.terminate();
            }
            const moved = await moveEnvironmentTask(environment.id, destination, context, {
              sessionHomes: isolatedHomes(root),
            });
            expect(moved.worktreePath).toBe(path.join(destination, path.basename(from)));
            expect(await exists(from)).toBe(false);
            expect(await exists(runtimeRoot)).toBe(false);
          } finally {
            await fs.rm(runtimeRoot, { recursive: true, force: true });
          }
        });
      },
    );
  }

  test("is refused while an agent is working or waiting, leaving the files in place", async () => {
    const { root, storage, context, startLocal } = await setup();
    const environment = await startLocal();
    for (const state of ["working", "waiting"] as const) {
      await storage.setEnvironmentAgentActivity(
        environment.id,
        state,
        new Date().toISOString(),
        "native-agent",
      );
      await expect(
        moveEnvironmentTask(environment.id, path.join(root, "elsewhere"), context),
      ).rejects.toThrow(AGENT_ACTIVE_MOVE_ERROR);
      expect(await exists(environment.worktreePath!)).toBe(true);
      const current = (await storage.getEnvironment(environment.id))!;
      expect(current.worktreePath).toBe(environment.worktreePath);
      expect(current.lifecycleOperation).toBeUndefined();
    }
  });

  test("refuses destinations that cannot hold the worktree", async () => {
    const { root, projectPath, context, startLocal } = await setup();
    const environment = await startLocal();
    const from = environment.worktreePath!;
    await expect(moveEnvironmentTask(environment.id, "relative", context)).rejects.toThrow(
      "absolute",
    );
    await expect(
      moveEnvironmentTask(environment.id, path.join(projectPath, "nested"), context),
    ).rejects.toThrow("project checkout");
    await expect(
      moveEnvironmentTask(environment.id, path.join(from, "inner"), context),
    ).rejects.toThrow("inside the environment's worktree");
    await expect(moveEnvironmentTask(environment.id, path.dirname(from), context)).rejects.toThrow(
      "already in this folder",
    );
    const occupied = path.join(root, "occupied");
    await fs.mkdir(path.join(occupied, path.basename(from)), { recursive: true });
    await expect(moveEnvironmentTask(environment.id, occupied, context)).rejects.toThrow(
      "already contains",
    );
    expect(await exists(from)).toBe(true);
  });

  test("refuses container environments and a second concurrent move", async () => {
    const { root, storage, context, startLocal } = await setup();
    const environment = await startLocal();
    await storage.updateEnvironment(environment.id, { environmentType: "containerized" });
    await expect(
      moveEnvironmentTask(environment.id, path.join(root, "elsewhere"), context),
    ).rejects.toThrow("Only a local environment");
    await storage.updateEnvironment(environment.id, { environmentType: "local" });

    expect(context.runtime.environments.fence.beginMove(environment.id)).toBe(true);
    try {
      await expect(
        moveEnvironmentTask(environment.id, path.join(root, "elsewhere"), context),
      ).rejects.toThrow("already being moved");
    } finally {
      context.runtime.environments.fence.endMove(environment.id);
    }
  });

  test("agent prompts are refused while a move is in progress", () => {
    const fence = new EnvironmentMutationFence();
    expect(fence.beginMove("env-fenced")).toBe(true);
    try {
      expect(() => fence.assertAcceptsAgentWork("env-fenced")).toThrow("being moved");
    } finally {
      fence.endMove("env-fenced");
    }
    expect(() => fence.assertAcceptsAgentWork("env-fenced")).not.toThrow();
  });

  test("is exposed as a registry command returning the client environment", async () => {
    const { root, commands, context, startLocal } = await setup();
    const environment = await startLocal();
    const destination = path.join(root, "via-command");
    // The command relocates agent state in the default homes; keep them private.
    const saved = { claude: process.env.CLAUDE_CONFIG_DIR, codex: process.env.CODEX_HOME };
    process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude-home");
    process.env.CODEX_HOME = path.join(root, "codex-home");
    let moved: Environment;
    try {
      moved = (await commands.get("move_environment")!(
        { environmentId: environment.id, destinationDir: destination },
        context,
      )) as Environment;
    } finally {
      if (saved.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved.claude;
      if (saved.codex === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = saved.codex;
    }
    expect(moved.worktreePath).toBe(
      path.join(destination, path.basename(environment.worktreePath!)),
    );
    expect("agentActivitySources" in moved).toBe(false);
    await expect(
      commands.get("move_environment")!(
        { environmentId: environment.id, destinationDir: destination, extra: true },
        context,
      ),
    ).rejects.toThrow();
  });
});

describe("interrupted move recovery", () => {
  test("adopts a completed rename and abandons an unfinished copy", async () => {
    const { root, projectPath, storage, context, startLocal } = await setup();
    const environment = await startLocal();
    const from = environment.worktreePath!;
    const destination = path.join(root, "elsewhere");
    const to = path.join(destination, path.basename(from));
    await fs.mkdir(destination, { recursive: true });
    // The backend stopped right after git renamed the worktree.
    await runCommand("git", ["-C", projectPath, "worktree", "move", from, to]);
    await storage.updateEnvironment(environment.id, {
      lifecycleOperation: "moving",
      worktreeMove: { from, to, phase: "moving", startedAt: new Date().toISOString() },
    });

    await recoverInterruptedEnvironmentMoves(context, { sessionHomes: isolatedHomes(root) });

    let current = (await storage.getEnvironment(environment.id))!;
    expect(current.worktreePath).toBe(to);
    expect(current.worktreeBaseDir).toBe(destination);
    expect(current.worktreeMove).toBeUndefined();
    expect(current.lifecycleOperation).toBeUndefined();

    // Then it stopped part-way through a copy back to the original folder.
    const staging = path.join(path.dirname(from), ".partial.orkestrator-move-abcd");
    await fs.mkdir(path.join(staging, "half"), { recursive: true });
    await storage.updateEnvironment(environment.id, {
      lifecycleOperation: "moving",
      worktreeMove: {
        from: to,
        to: from,
        staging,
        phase: "moving",
        startedAt: new Date().toISOString(),
      },
    });

    await recoverInterruptedEnvironmentMoves(context, { sessionHomes: isolatedHomes(root) });

    current = (await storage.getEnvironment(environment.id))!;
    expect(current.worktreePath).toBe(to);
    expect(current.worktreeMove).toBeUndefined();
    expect(current.lifecycleOperation).toBeUndefined();
    expect(current.lifecycleError).toContain("move it again");
    expect(await exists(staging)).toBe(false);
    expect(await exists(to)).toBe(true);
  });
});

describe("move failure boundaries", () => {
  for (const forceCopy of [false, true]) {
    test(`keeps committed destination after bookkeeping failure (${forceCopy})`, async () => {
      const { root, storage, context, startLocal, projectPath } = await setup();
      const environment = await startLocal();
      spyOn(storage, "clearBackendTerminalSessionIds").mockRejectedValueOnce(
        new Error("bookkeeping failed"),
      );
      const result = await moveEnvironmentTask(environment.id, path.join(root, "moved"), context, {
        forceCopy,
        sessionHomes: isolatedHomes(root),
      });
      expect(result.lifecycleError).toContain("completion will retry");
      expect(result.worktreeMove?.phase).toBe("committed");
      expect(await exists(result.worktreePath!)).toBe(true);
      expect(await registeredWorktrees(projectPath)).toContain(result.worktreePath!);
      await recoverInterruptedEnvironmentMoves(context, { sessionHomes: isolatedHomes(root) });
      const recovered = (await storage.getEnvironment(environment.id))!;
      expect(recovered.worktreePath).toBe(result.worktreePath);
      expect(recovered.worktreeMove).toBeUndefined();
      expect(await exists(environment.worktreePath!)).toBe(false);
    });
  }

  test("a rejected commit rolls back the rename without losing its source", async () => {
    const { root, storage, context, startLocal, projectPath } = await setup();
    const environment = await startLocal();
    const update = storage.updateEnvironment.bind(storage);
    spyOn(storage, "updateEnvironment").mockImplementation(async (id, changes) => {
      if ((changes.worktreeMove as { phase?: string } | undefined)?.phase === "committed")
        throw new Error("commit rejected");
      return update(id, changes);
    });
    await expect(
      moveEnvironmentTask(environment.id, path.join(root, "moved"), context, {
        sessionHomes: isolatedHomes(root),
      }),
    ).rejects.toThrow("commit rejected");
    expect((await storage.getEnvironment(environment.id))?.worktreePath).toBe(
      environment.worktreePath,
    );
    expect(await registeredWorktrees(projectPath)).toContain(environment.worktreePath!);
    expect(await exists(environment.worktreePath!)).toBe(true);
  });

  test("refuses transfer when tmux termination is incomplete", async () => {
    const { root, storage, context, startLocal } = await setup();
    const environment = await startLocal();
    spyOn(tmux, "cleanupEnvironmentTmux").mockRejectedValue(new Error("cleanup incomplete"));
    await expect(
      moveEnvironmentTask(environment.id, path.join(root, "moved"), context, {
        sessionHomes: isolatedHomes(root),
      }),
    ).rejects.toThrow("cleanup incomplete");
    expect(await exists(environment.worktreePath!)).toBe(true);
    expect((await storage.getEnvironment(environment.id))?.worktreePath).toBe(
      environment.worktreePath,
    );
    expect(await exists(path.join(root, "moved"))).toBe(false);
  });

  test("reports provider failure and retries migration and source cleanup after restart", async () => {
    const { root, storage, context, startLocal } = await setup();
    const environment = await startLocal();
    const homes = isolatedHomes(root);
    const source = path.join(
      homes.codexHomes[0]!,
      "orkestrator-bridge",
      `bridge-sessions-${codexCwdHash(environment.worktreePath!)}`,
    );
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "broken.json"), "invalid");
    const moved = await moveEnvironmentTask(environment.id, path.join(root, "moved"), context, {
      forceCopy: true,
      sessionHomes: homes,
    });
    expect(moved.lifecycleError).toContain("Codex");
    expect(moved.worktreeMove?.phase).toBe("committed");
    expect(await exists(environment.worktreePath!)).toBe(true);
    await fs.writeFile(
      path.join(source, "broken.json"),
      JSON.stringify({ cwdHash: codexCwdHash(environment.worktreePath!) }),
    );
    const restarted = new StorageService(storage.getDataDir());
    await restarted.init();
    await recoverInterruptedEnvironmentMoves(
      { ...context, storage: restarted },
      { sessionHomes: homes },
    );
    expect((await restarted.getEnvironment(environment.id))?.worktreeMove).toBeUndefined();
    expect(await exists(environment.worktreePath!)).toBe(false);
  });

  test("detects EXDEV and cleans a failed copy", async () => {
    const { root, context, startLocal, projectPath } = await setup();
    const environment = await startLocal();
    const run = shell.runCommand;
    let copies = 0;
    spyOn(shell, "runCommand").mockImplementation(async (command, args, options) => {
      if (command === "git" && args?.includes("move")) throw new Error("EXDEV cross-device link");
      if (command === "cp") {
        copies++;
        await fs.mkdir(args![2]!, { recursive: true });
        throw new Error("copy failed");
      }
      return run(command, args, options);
    });
    const destination = path.join(root, "elsewhere");
    await expect(
      moveEnvironmentTask(environment.id, destination, context, {
        sessionHomes: isolatedHomes(root),
      }),
    ).rejects.toThrow("copy failed");
    expect(await fs.readdir(destination)).toEqual([]);
    expect(await registeredWorktrees(projectPath)).toContain(environment.worktreePath!);
    expect(copies).toBe(1);
  });

  test("refuses project home, running setup and backend shutdown", async () => {
    const { root, storage, context, startLocal } = await setup();
    const environment = await startLocal();
    const home = { ...environment, id: `${environment.id}-home`, projectHome: true };
    await storage.addEnvironment(home);
    await expect(moveEnvironmentTask(home.id, path.join(root, "moved"), context)).rejects.toThrow(
      "project home",
    );
    await storage.updateEnvironment(environment.id, { setupPhase: "running" });
    await expect(
      moveEnvironmentTask(environment.id, path.join(root, "moved"), context),
    ).rejects.toThrow("setup is still running");
    context.runtime.localServers.closeAdmission();
    await expect(
      moveEnvironmentTask(environment.id, path.join(root, "moved"), context),
    ).rejects.toThrow("shutting down");
  });

  test("recovers a copied move, both source spellings, and interruption during recovery", async () => {
    const { root, storage, context, startLocal, projectPath } = await setup();
    const environment = await startLocal();
    const from = environment.worktreePath!;
    const alias = path.join(root, "alias");
    await fs.symlink(path.dirname(from), alias);
    const spelledFrom = path.join(alias, path.basename(from));
    const to = path.join(root, "moved", path.basename(from));
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.cp(from, to, { recursive: true });
    const homes = isolatedHomes(root);
    for (const [i, source] of [from, spelledFrom].entries()) {
      const transcripts = path.join(homes.claudeConfigDir, "projects", claudeProjectSlug(source));
      await fs.mkdir(transcripts, { recursive: true });
      await fs.writeFile(path.join(transcripts, `session-${i}.jsonl`), "{}\n");
    }
    await storage.updateEnvironment(environment.id, {
      worktreeMove: {
        sourceIdentity: { dev: (await fs.stat(from)).dev, ino: (await fs.stat(from)).ino },
        from: spelledFrom,
        fromCanonical: from,
        fromRoot: alias,
        to,
        phase: "copied",
        startedAt: new Date().toISOString(),
      },
      lifecycleOperation: "moving",
    });
    spyOn(storage, "clearBackendTerminalSessionIds").mockRejectedValueOnce(
      new Error("restart interrupted"),
    );
    await recoverInterruptedEnvironmentMoves(context, { sessionHomes: homes });
    const interrupted = (await storage.getEnvironment(environment.id))!;
    expect(interrupted.worktreeMove?.phase).toBe("committed");
    expect(interrupted.worktreePath).toBe(to);
    await recoverInterruptedEnvironmentMoves(context, { sessionHomes: homes });
    expect((await storage.getEnvironment(environment.id))?.worktreeMove).toBeUndefined();
    expect(await exists(from)).toBe(false);
    expect(await registeredWorktrees(projectPath)).toContain(to);
    for (const i of [0, 1])
      expect(
        await fs.readFile(
          path.join(homes.claudeConfigDir, "projects", claudeProjectSlug(to), `session-${i}.jsonl`),
          "utf8",
        ),
      ).toContain('"relocatedCwd"');
  });
});
