import { afterEach, describe, expect, test, mock, spyOn } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createCommandRegistry, type CommandContext } from "./commands.js";
import { startEnvironmentOnce } from "./commands-environment.js";
import { diffStatsService } from "./commands-runtime-state.js";
import { prMonitorService } from "./commands-pr-monitor.js";
import { EnvironmentLifecycleTaskTracker } from "./environment-lifecycle-tasks.js";
import {
  AGENT_ACTIVE_MOVE_ERROR,
  moveEnvironmentTask,
  recoverInterruptedEnvironmentMoves,
} from "./environment-move.js";
import { claudeProjectSlug, codexCwdHash } from "./environment-move-sessions.js";
import {
  assertEnvironmentAcceptsAgentWork,
  beginEnvironmentMove,
  endEnvironmentMove,
} from "./environment-replacement-fence.js";
import type { Environment } from "./models.js";
import { runCommand } from "./shell.js";
import * as shell from "./shell.js";
import * as tmux from "./tmux-commands.js";
import * as pathSafety from "./path-safety.js";
import { setLocalServerShutdownRequested } from "./commands-runtime-state.js";
import { createProject, StorageService } from "./storage.js";
import { parseWorktreeMoveRecord } from "./storage-projects.js";

const roots: string[] = [];

afterEach(async () => {
  mock.restore();
  setLocalServerShutdownRequested(false);
  for (const id of diffStatsService.trackedIds()) diffStatsService.untrack(id);
  prMonitorService.sync([]);
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ork-env-move-")));
  roots.push(root);
  const projectPath = path.join(root, "app");
  await runCommand("git", ["init", "-q", "-b", "main", projectPath]);
  await fs.writeFile(path.join(projectPath, "README.md"), "fixture");
  await runCommand("git", ["-C", projectPath, "add", "."]);
  await runCommand("git", [
    "-C",
    projectPath,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "fixture",
  ]);
  const origin = path.join(root, "origin.git");
  await runCommand("git", ["clone", "-q", "--bare", projectPath, origin]);
  await runCommand("git", ["-C", projectPath, "remote", "add", "origin", origin]);
  await runCommand("git", ["-C", projectPath, "fetch", "-q", "origin"]);
  const storage = new StorageService(path.join(root, "data"));
  await storage.init();
  const project = await storage.addProject(
    createProject("https://github.com/acme/app.git", projectPath),
  );
  const commands = createCommandRegistry();
  const context = {
    storage,
    appRoot: "",
    resourceRoot: "",
    emit: () => undefined,
    environmentLifecycleTasks: new EnvironmentLifecycleTaskTracker(),
  } as CommandContext;
  const startLocal = async (): Promise<Environment> => {
    const created = (await commands.get("create_environment")!(
      {
        projectId: project.id,
        environmentType: "local",
        branch: "feature",
        worktreeBaseDir: path.join(root, "trees"),
      },
      context,
    )) as Environment;
    await storage.updateEnvironment(created.id, { setupOverride: true });
    await startEnvironmentOnce(created.id, context, () => {});
    return (await storage.getEnvironment(created.id))!;
  };
  return { root, projectPath, storage, context, commands, startLocal };
}

const gitIdentity = [
  "-c",
  "user.name=Test",
  "-c",
  "user.email=test@example.invalid",
  "-c",
  "protocol.file.allow=always",
];

async function commitFixtureRepo(repo: string, file: string): Promise<void> {
  await runCommand("git", ["init", "-q", "-b", "main", repo]);
  await fs.writeFile(path.join(repo, file), file);
  await runCommand("git", ["-C", repo, "add", "."]);
  await runCommand("git", ["-C", repo, ...gitIdentity, "commit", "-qm", file]);
}

/**
 * Adds `libs/sub` (which itself nests `nested`) to the project and checks
 * both out in the environment's worktree, with git dirs under the repository.
 */
async function addNestedSubmodules(root: string, projectPath: string, worktree: string) {
  const nested = path.join(root, "nested-src");
  const sub = path.join(root, "sub-src");
  await commitFixtureRepo(nested, "nested.txt");
  await commitFixtureRepo(sub, "sub.txt");
  await runCommand("git", ["-C", sub, ...gitIdentity, "submodule", "add", "-q", nested, "nested"]);
  await runCommand("git", ["-C", sub, ...gitIdentity, "commit", "-qm", "nested"]);
  await runCommand("git", [
    "-C",
    projectPath,
    ...gitIdentity,
    "submodule",
    "add",
    "-q",
    sub,
    "libs/sub",
  ]);
  await runCommand("git", ["-C", projectPath, ...gitIdentity, "commit", "-qm", "submodule"]);
  const { stdout: head } = await runCommand("git", ["-C", projectPath, "rev-parse", "HEAD"]);
  await runCommand("git", ["-C", worktree, "reset", "-q", "--hard", head.trim()]);
  await runCommand("git", [
    "-C",
    worktree,
    ...gitIdentity,
    "submodule",
    "update",
    "-q",
    "--init",
    "--recursive",
  ]);
  await fs.writeFile(path.join(worktree, "libs", "sub", "nested", "local.txt"), "uncommitted");
}

/** Asserts both submodule checkouts in `worktree` resolve to themselves and are clean but for local work. */
async function expectSubmodulesLinked(worktree: string): Promise<void> {
  const real = await fs.realpath(worktree);
  for (const relative of ["libs/sub", "libs/sub/nested"]) {
    const { stdout: top } = await runCommand("git", [
      "-C",
      path.join(worktree, relative),
      "rev-parse",
      "--show-toplevel",
    ]);
    expect(top.trim()).toBe(path.join(real, relative));
  }
  const { stdout: status } = await runCommand("git", [
    "-C",
    worktree,
    "submodule",
    "status",
    "--recursive",
  ]);
  expect(status).toContain("libs/sub/nested");
  expect(status.split("\n").filter((line) => /^[-+U]/.test(line))).toEqual([]);
  const { stdout: nestedStatus } = await runCommand("git", [
    "-C",
    path.join(worktree, "libs", "sub", "nested"),
    "status",
    "--porcelain",
  ]);
  expect(nestedStatus).toContain("local.txt");
}

async function registeredWorktrees(projectPath: string): Promise<string[]> {
  const { stdout } = await runCommand("git", [
    "-C",
    projectPath,
    "worktree",
    "list",
    "--porcelain",
  ]);
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

function isolatedHomes(root: string) {
  return {
    claudeConfigDir: path.join(root, "claude-home"),
    claudeJsonPath: path.join(root, "claude.json"),
    codexHomes: [path.join(root, "codex-home")],
    cursorStateDir: path.join(root, "cursor-state"),
  };
}

async function exists(target: string): Promise<boolean> {
  return fs
    .stat(target)
    .then(() => true)
    .catch(() => false);
}

describe("move_environment", () => {
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

    expect(beginEnvironmentMove(environment.id)).toBe(true);
    try {
      await expect(
        moveEnvironmentTask(environment.id, path.join(root, "elsewhere"), context),
      ).rejects.toThrow("already being moved");
    } finally {
      endEnvironmentMove(environment.id);
    }
  });

  test("agent prompts are refused while a move is in progress", () => {
    expect(beginEnvironmentMove("env-fenced")).toBe(true);
    try {
      expect(() => assertEnvironmentAcceptsAgentWork("env-fenced")).toThrow("being moved");
    } finally {
      endEnvironmentMove("env-fenced");
    }
    expect(() => assertEnvironmentAcceptsAgentWork("env-fenced")).not.toThrow();
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
    setLocalServerShutdownRequested(true);
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

test("restart recovery re-links submodules of an adopted or abandoned copy", async () => {
  const { root, storage, context, startLocal, projectPath } = await setup();
  const environment = await startLocal();
  const from = environment.worktreePath!;
  await addNestedSubmodules(root, projectPath, from);
  const { stdout: listed } = await runCommand("git", [
    "-C",
    from,
    "submodule",
    "--quiet",
    "foreach",
    "--recursive",
    'printf "%s|%s\\n" "$displaypath" "$(git rev-parse --absolute-git-dir)"',
  ]);
  const submodules = listed
    .trim()
    .split("\n")
    .map((line) => {
      const [relative, gitDir] = line.split("|");
      return { path: relative!, gitDir: gitDir! };
    });
  expect(submodules.map((entry) => entry.path)).toEqual(["libs/sub", "libs/sub/nested"]);

  // Stopped after the copy was renamed into place, before anything was re-linked.
  const to = path.join(root, "moved", "deeper", path.basename(from));
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.cp(from, to, { recursive: true, verbatimSymlinks: true });
  await storage.updateEnvironment(environment.id, {
    worktreeMove: { from, to, submodules, phase: "moving", startedAt: new Date().toISOString() },
    lifecycleOperation: "moving",
  });
  // A half re-link left the source's submodule pointing at the copy.
  await runCommand("git", [
    "config",
    "--file",
    path.join(submodules[0]!.gitDir, "config"),
    "core.worktree",
    path.relative(submodules[0]!.gitDir, path.join(await fs.realpath(to), "libs", "sub")),
  ]);
  await recoverInterruptedEnvironmentMoves(context, { sessionHomes: isolatedHomes(root) });
  let recovered = (await storage.getEnvironment(environment.id))!;
  expect(recovered.worktreePath).toBe(from);
  expect(recovered.lifecycleError).toContain("left a copy");
  await expectSubmodulesLinked(from);

  // The same copy, recorded as finished, is adopted with its submodules.
  await fs.rm(to, { recursive: true, force: true });
  await fs.cp(from, to, { recursive: true, verbatimSymlinks: true });
  await storage.updateEnvironment(environment.id, {
    worktreeMove: { from, to, submodules, phase: "copied", startedAt: new Date().toISOString() },
    lifecycleOperation: "moving",
  });
  await recoverInterruptedEnvironmentMoves(context, { sessionHomes: isolatedHomes(root) });
  recovered = (await storage.getEnvironment(environment.id))!;
  expect(recovered.worktreePath).toBe(to);
  expect(recovered.worktreeMove).toBeUndefined();
  expect(await exists(from)).toBe(false);
  expect(await registeredWorktrees(projectPath)).toContain(to);
  await expectSubmodulesLinked(to);
});

test("persisted submodule links are confined to the worktree", () => {
  const base = { from: "/a/one", to: "/b/one", phase: "copied", startedAt: "now" };
  const submodules = [{ path: "libs/sub", gitDir: "/repo/.git/worktrees/one/modules/libs/sub" }];
  expect(parseWorktreeMoveRecord({ ...base, submodules }).submodules).toEqual(submodules);
  expect(parseWorktreeMoveRecord(base).submodules).toBeUndefined();
  for (const bad of ["../escape", "/abs", "libs//sub", ""]) {
    expect(() =>
      parseWorktreeMoveRecord({ ...base, submodules: [{ path: bad, gitDir: "/g" }] }),
    ).toThrow("submodule path");
  }
  expect(() =>
    parseWorktreeMoveRecord({ ...base, submodules: [{ path: "libs/sub", gitDir: "relative" }] }),
  ).toThrow("submodule git dir");
});

test("abandons a final copy without a copied-phase record and repairs the original", async () => {
  const { root, storage, context, startLocal, projectPath } = await setup();
  const environment = await startLocal();
  const from = environment.worktreePath!;
  const to = path.join(root, "moved", path.basename(from));
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.cp(from, to, { recursive: true });
  await runCommand("git", ["-C", projectPath, "worktree", "repair", to]);
  await storage.updateEnvironment(environment.id, {
    worktreeMove: { from, to, phase: "moving", startedAt: new Date().toISOString() },
    lifecycleOperation: "moving",
  });
  await recoverInterruptedEnvironmentMoves(context, { sessionHomes: isolatedHomes(root) });
  const recovered = (await storage.getEnvironment(environment.id))!;
  expect(recovered.worktreePath).toBe(from);
  expect(recovered.worktreeMove).toBeUndefined();
  expect(recovered.lifecycleError).toContain("left a copy");
  expect(await registeredWorktrees(projectPath)).toContain(from);
  expect(await exists(to)).toBe(true);
});

test("source cleanup failure retains a committed copy for restart retry", async () => {
  const { root, storage, context, startLocal } = await setup();
  const environment = await startLocal();
  const removal = spyOn(pathSafety, "removeConfinedDirectory").mockRejectedValueOnce(
    new Error("source cleanup failed"),
  );
  const moved = await moveEnvironmentTask(environment.id, path.join(root, "moved"), context, {
    forceCopy: true,
    sessionHomes: isolatedHomes(root),
  });
  expect(moved.lifecycleError).toContain("source cleanup failed");
  expect(moved.worktreeMove?.phase).toBe("committed");
  expect(await exists(environment.worktreePath!)).toBe(true);
  removal.mockRestore();
  await recoverInterruptedEnvironmentMoves(context, { sessionHomes: isolatedHomes(root) });
  expect(await exists(environment.worktreePath!)).toBe(false);
  expect((await storage.getEnvironment(environment.id))?.worktreeMove).toBeUndefined();
});

test("a storage rejection after publishing the path never rolls it back", async () => {
  const { root, storage, context, startLocal, projectPath } = await setup();
  const environment = await startLocal();
  const update = storage.updateEnvironment.bind(storage);
  let rejected = false;
  spyOn(storage, "updateEnvironment").mockImplementation(async (id, changes) => {
    const result = await update(id, changes);
    if (
      !rejected &&
      (changes.worktreeMove as { phase?: string } | undefined)?.phase === "committed"
    ) {
      rejected = true;
      throw new Error("notification rejected after commit");
    }
    return result;
  });
  const moved = await moveEnvironmentTask(environment.id, path.join(root, "moved"), context, {
    sessionHomes: isolatedHomes(root),
  });
  expect(moved.lifecycleError).toContain("notification rejected after commit");
  expect(moved.worktreeMove?.phase).toBe("committed");
  expect(await exists(moved.worktreePath!)).toBe(true);
  expect(await exists(environment.worktreePath!)).toBe(false);
  expect(await registeredWorktrees(projectPath)).toContain(moved.worktreePath!);
  await recoverInterruptedEnvironmentMoves(context, { sessionHomes: isolatedHomes(root) });
  expect((await storage.getEnvironment(environment.id))?.worktreeMove).toBeUndefined();
});
