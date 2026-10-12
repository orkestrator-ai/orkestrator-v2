import { afterEach, describe, expect, test } from "bun:test";
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
import { createProject, StorageService } from "./storage.js";

const roots: string[] = [];

afterEach(async () => {
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
