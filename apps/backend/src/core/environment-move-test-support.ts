// Shared fixtures for the environment-move.*.test.ts files. Each file registers
// the hooks below with registerEnvironmentMoveFixtureHooks(); the repository
// templates are built once per file (and per worker) and copied per test.

import { afterAll, afterEach, beforeEach, expect, mock, spyOn } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Environment } from "./models.js";
import { createCommandRegistry, type CommandContext } from "./commands.js";
import { startEnvironmentOnce } from "./commands-environment.js";
import { EnvironmentLifecycleTaskTracker } from "./environment-lifecycle-tasks.js";
import { runCommand } from "./shell.js";
import { TmuxBackend } from "./tmux-backend.js";
import { createProject, StorageService } from "./storage.js";
import { BackendRuntime } from "./backend-runtime.js";
import { removeFixturesAfterSettlement } from "../../tests/fixture-cleanup.js";
import { ownedTempDirPrefix, sweepStaleTempDirs } from "../../../../tests/temp-sweep.js";

// An Arch Linux sweep (0247) found `ork-env-move-*` roots left by runs whose
// tests passed: a diff scan still running at teardown wrote the project's
// `.git/info/exclude`, so teardown also settles diff scans. Roots carry their
// owner's PID and a later run removes those of dead owners.
const TEMP_PREFIXES = ["ork-env-move-", "ork-env-move-template-"];
sweepStaleTempDirs({
  prefix: TEMP_PREFIXES,
  maxAgeMs: 60 * 60 * 1_000,
  // Legacy roots have no owner to check; allow a full day before recovery.
  legacyMaxAgeMs: 24 * 60 * 60 * 1_000,
});

const roots: string[] = [];
const runtimes: BackendRuntime[] = [];
export const listTmuxSessions = mock(async (args: string[]) => {
  expect(args).toEqual(["tmux", "list-sessions", "-F", "#{session_name}"]);
  // What tmux prints when no server has used the socket since /tmp was cleared.
  return {
    status: 1,
    stdout: "",
    stderr: "error connecting to /private/tmp/tmux-501/default (No such file or directory)",
  };
});
let optionalLocks: string | undefined;

// The project repository with its bare `origin`, and the two submodule source
// repositories, are built once per file and copied per test, so every test
// still owns independent repositories without paying for their Git processes.
let templates: Promise<string> | undefined;

export function registerEnvironmentMoveFixtureHooks() {
  beforeEach(() => {
    optionalLocks = process.env.GIT_OPTIONAL_LOCKS;
    // Watchers may run status while fixtures reset the index.
    process.env.GIT_OPTIONAL_LOCKS = "0";
    // These fixtures own no tmux processes. Keep cleanup and hook restoration
    // real, but use a known-empty inventory instead of the host's tmux sessions.
    listTmuxSessions.mockClear();
    const exec = TmuxBackend.prototype.exec;
    spyOn(TmuxBackend.prototype, "exec").mockImplementation(function (this: TmuxBackend, ...args) {
      if (args[0][0] === "tmux") return listTmuxSessions(args[0]);
      if (args[0][0] === "ps")
        return Promise.resolve({ status: 0, stdout: "1 /sbin/init\n", stderr: "" });
      return exec.apply(this, args);
    });
  });

  afterEach(async () => {
    mock.restore();
    if (optionalLocks === undefined) delete process.env.GIT_OPTIONAL_LOCKS;
    else process.env.GIT_OPTIONAL_LOCKS = optionalLocks;
    const finished = runtimes.splice(0);
    for (const runtime of finished) runtime.shutdown();
    await removeFixturesAfterSettlement(
      () =>
        Promise.all(
          finished.flatMap((runtime) => [
            runtime.terminals.history.settled(),
            runtime.diffStats.settled(),
          ]),
        ),
      roots.splice(0),
    );
  });

  afterAll(async () => {
    // Each file removes the templates it built; the next file builds its own.
    const pending = templates;
    templates = undefined;
    const root = await pending?.catch(() => undefined);
    if (root) await fs.rm(root, { recursive: true, force: true });
  });
}

async function buildTemplates(): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(ownedTempDirPrefix("ork-env-move-template-")));
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
  await commitFixtureRepo(path.join(root, "nested-src"), "nested.txt");
  await commitFixtureRepo(path.join(root, "sub-src"), "sub.txt");
  return root;
}

function templateRoot(): Promise<string> {
  templates ??= buildTemplates().catch((error: unknown) => {
    templates = undefined;
    throw error;
  });
  return templates;
}

/**
 * Copies template entries to the same relative paths under `root`, re-pointing
 * the absolute template paths in the named Git configs at `root`.
 */
async function copyTemplate(
  root: string,
  entries: string[],
  configs: string[] = [],
): Promise<void> {
  const template = await templateRoot();
  for (const entry of entries) {
    await fs.cp(path.join(template, entry), path.join(root, entry), { recursive: true });
  }
  for (const config of configs) {
    const configPath = path.join(root, config);
    const content = await fs.readFile(configPath, "utf8");
    if (!content.includes(template)) {
      throw new Error(`The template ${config} no longer names a template path`);
    }
    await fs.writeFile(configPath, content.replaceAll(template, root));
  }
}

export async function setup() {
  const root = await fs.realpath(await fs.mkdtemp(ownedTempDirPrefix("ork-env-move-")));
  roots.push(root);
  const projectPath = path.join(root, "app");
  // `app` names `origin.git` as its remote and the bare clone names `app`.
  await copyTemplate(
    root,
    ["app", "origin.git"],
    [path.join("app", ".git", "config"), path.join("origin.git", "config")],
  );
  const storage = new StorageService(path.join(root, "data"));
  await storage.init();
  const project = await storage.addProject(
    createProject("https://github.com/acme/app.git", projectPath),
  );
  const commands = createCommandRegistry();
  const runtime = new BackendRuntime({ emit: () => undefined });
  runtimes.push(runtime);
  const context = {
    storage,
    appRoot: "",
    resourceRoot: "",
    emit: () => undefined,
    environmentLifecycleTasks: new EnvironmentLifecycleTaskTracker(),
    runtime,
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
export async function addNestedSubmodules(root: string, projectPath: string, worktree: string) {
  const nested = path.join(root, "nested-src");
  const sub = path.join(root, "sub-src");
  await copyTemplate(root, ["nested-src", "sub-src"]);
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
export async function expectSubmodulesLinked(worktree: string): Promise<void> {
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

export async function registeredWorktrees(projectPath: string): Promise<string[]> {
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

export function isolatedHomes(root: string) {
  return {
    claudeConfigDir: path.join(root, "claude-home"),
    claudeJsonPath: path.join(root, "claude.json"),
    codexHomes: [path.join(root, "codex-home")],
    cursorStateDir: path.join(root, "cursor-state"),
  };
}

export async function exists(target: string): Promise<boolean> {
  return fs
    .stat(target)
    .then(() => true)
    .catch(() => false);
}
