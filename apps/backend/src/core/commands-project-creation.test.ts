import { describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCommandRegistry, type CommandContext } from "./commands.js";
import { EnvironmentLifecycleTaskTracker } from "./environment-lifecycle-tasks.js";
import type { Project } from "./models.js";
import {
  CommandFailedError,
  runCommand as shellRunCommand,
} from "./shell.js";
import { StorageService } from "./storage.js";

type Run = typeof shellRunCommand;

async function withProjectCreation<T>(
  runCommand: Run,
  run: (
    invoke: (localPath: string) => Promise<unknown>,
    storage: StorageService,
    root: string,
    invokeArgs: (args: Record<string, unknown>) => Promise<unknown>,
  ) => Promise<T>,
): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-project-create-"));
  const storage = new StorageService(path.join(root, "data"));
  await storage.init();
  const commands = createCommandRegistry({ projectCreation: { runCommand } });
  const context = {
    storage,
    appRoot: "",
    resourceRoot: "",
    emit: () => undefined,
    environmentLifecycleTasks: new EnvironmentLifecycleTaskTracker(),
  } as CommandContext;
  const handler = commands.get("create_project_from_scratch");
  if (!handler) throw new Error("create_project_from_scratch is not registered");
  const invokeArgs = async (args: Record<string, unknown>) => handler(args, context);

  try {
    return await run(
      (localPath) => invokeArgs({ localPath }),
      storage,
      root,
      invokeArgs,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function successfulRunner(
  calls: Array<{ command: string; args: string[]; timeoutMs?: number }> = [],
): Run {
  return mock(async (command: string, args: string[] = [], options = {}) => {
    const timeoutMs = (options as { timeoutMs?: number }).timeoutMs;
    calls.push({ command, args, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    if (command === "gh" && args[1] === "create") {
      const source = args.find((arg) => arg.startsWith("--source="))?.slice(9);
      if (!source) throw new Error("missing source path");
      await shellRunCommand("git", [
        "-C", source, "remote", "add", "origin",
        `https://github.com/test/${path.basename(source)}.git`,
      ]);
      return { stdout: "", stderr: "" };
    }
    if (command === "git" && args[2] === "push") return { stdout: "", stderr: "" };
    return shellRunCommand(command, args, options);
  });
}

async function remainsPending(promise: Promise<unknown>, timeoutMs = 50): Promise<boolean> {
  return Promise.race([
    promise.then(() => false, () => false),
    new Promise<true>((resolve) => setTimeout(() => resolve(true), timeoutMs)),
  ]);
}

describe("create_project_from_scratch", () => {
  test("creates, verifies, pushes, and persists a private repository in separate phases", async () => {
    const calls: Array<{ command: string; args: string[]; timeoutMs?: number }> = [];
    const runCommand = successfulRunner(calls);

    await withProjectCreation(runCommand, async (invoke, storage, root) => {
      const projectPath = path.join(root, "blank-canvas");
      const project = await invoke(projectPath) as {
        name: string;
        gitUrl: string;
        localPath: string;
      };

      expect(project).toMatchObject({
        name: "blank-canvas",
        gitUrl: "https://github.com/test/blank-canvas.git",
        localPath: projectPath,
      });
      expect(calls).toEqual([
        { command: "git", args: ["-C", projectPath, "init", "-b", "main"], timeoutMs: 30_000 },
        {
          command: "git",
          args: [
            "-C", projectPath,
            "-c", "user.name=Orkestrator",
            "-c", "user.email=projects@orkestrator.local",
            "commit", "--allow-empty", "--no-gpg-sign", "-m", "Initial commit",
          ],
          timeoutMs: 30_000,
        },
        {
          command: "gh",
          args: [
            "repo", "create", "blank-canvas", "--private",
            `--source=${projectPath}`, "--remote=origin",
          ],
          timeoutMs: 120_000,
        },
        {
          command: "git",
          args: ["-C", projectPath, "remote", "get-url", "origin"],
          timeoutMs: 10_000,
        },
        {
          command: "git",
          args: ["-C", projectPath, "push", "--set-upstream", "origin", "main"],
          timeoutMs: 120_000,
        },
      ]);
      await expect(shellRunCommand(
        "git",
        ["-C", projectPath, "rev-parse", "--verify", "main^{commit}"],
      )).resolves.toMatchObject({ stdout: expect.stringMatching(/^[0-9a-f]{40}\n$/) });
      expect(await storage.loadProjects()).toHaveLength(1);
    });
  });

  test("rejects blank, unknown, relative, root, file, symlink, and non-empty targets", async () => {
    const runCommand = mock(async () => ({ stdout: "", stderr: "" }));
    await withProjectCreation(runCommand, async (invoke, _storage, root, invokeArgs) => {
      await expect(invokeArgs({ localPath: " " })).rejects.toThrow(/non-blank string/);
      await expect(invokeArgs({ localPath: path.join(root, "new"), extra: true }))
        .rejects.toThrow("Unexpected arguments field: extra");
      await expect(invoke("relative/project")).rejects.toThrow("absolute path");
      await expect(invoke(path.parse(root).root)).rejects.toThrow("filesystem root");

      const filePath = path.join(root, "file");
      await fs.writeFile(filePath, "data");
      await expect(invoke(filePath)).rejects.toThrow("must be a directory");

      const target = path.join(root, "target");
      const symlink = path.join(root, "symlink");
      await fs.mkdir(target);
      await fs.symlink(target, symlink, "dir");
      await expect(invoke(symlink)).rejects.toThrow("cannot be a symbolic link");

      const occupied = path.join(root, "occupied");
      await fs.mkdir(occupied);
      await fs.writeFile(path.join(occupied, "keep.txt"), "mine");
      await expect(invoke(occupied)).rejects.toThrow("new or an empty directory");
      await expect(fs.readFile(path.join(occupied, "keep.txt"), "utf8")).resolves.toBe("mine");
      expect(runCommand).not.toHaveBeenCalled();
    });
  });

  test("rejects a leading-dash repository name before invoking a CLI", async () => {
    const runCommand = mock(async () => ({ stdout: "", stderr: "" }));
    await withProjectCreation(runCommand, async (invoke, _storage, root) => {
      await expect(invoke(path.join(root, "--public"))).rejects.toThrow("cannot begin with a dash");
      expect(runCommand).not.toHaveBeenCalled();
    });
  });

  test("detects a duplicate canonical path through a symlinked parent", async () => {
    const runCommand = mock(async () => ({ stdout: "", stderr: "" }));
    await withProjectCreation(runCommand, async (invoke, storage, root) => {
      const realParent = path.join(root, "real-parent");
      const aliasParent = path.join(root, "alias-parent");
      await fs.mkdir(realParent);
      await fs.symlink(realParent, aliasParent, "dir");
      await storage.addProject({
        id: "existing",
        name: "existing",
        gitUrl: "https://example.invalid/existing.git",
        localPath: path.join(realParent, "new"),
        addedAt: new Date(0).toISOString(),
        order: 0,
      } satisfies Project);

      await expect(invoke(path.join(aliasParent, "new"))).rejects.toThrow(
        "A project already uses this local path",
      );
      expect(runCommand).not.toHaveBeenCalled();
    });
  });

  test.each([
    ["missing Git", new CommandFailedError("spawn git ENOENT", { executableMissing: true }), "Git is not installed"],
    ["Git init timeout", new CommandFailedError("init timed out", { timedOut: true }), "init timed out"],
  ])("rolls back a new directory after %s", async (_name, failure, expected) => {
    const runCommand = mock(async () => { throw failure; });
    await withProjectCreation(runCommand, async (invoke, _storage, root) => {
      const projectPath = path.join(root, "failed-init");
      await expect(invoke(projectPath)).rejects.toThrow(expected);
      await expect(fs.access(projectPath)).rejects.toThrow();
    });
  });

  test("rolls back Git metadata after an initial commit failure without deleting user content", async () => {
    const runCommand = mock(async (command: string, args: string[] = [], options = {}) => {
      if (command === "git" && args[2] === "init") {
        const result = await shellRunCommand(command, args, options);
        await fs.writeFile(path.join(args[1]!, "appeared.txt"), "keep");
        return result;
      }
      throw new CommandFailedError("commit timed out", { timedOut: true });
    });
    await withProjectCreation(runCommand, async (invoke, _storage, root) => {
      const projectPath = path.join(root, "failed-commit");
      await expect(invoke(projectPath)).rejects.toThrow("Could not create the initial Git commit: commit timed out");
      await expect(fs.readFile(path.join(projectPath, "appeared.txt"), "utf8")).resolves.toBe("keep");
      await expect(fs.access(path.join(projectPath, ".git"))).rejects.toThrow();
    });
  });

  test("rolls back when GitHub CLI is definitely missing", async () => {
    const runCommand = mock(async (command: string, args: string[] = [], options = {}) => {
      if (command === "gh") {
        throw new CommandFailedError("spawn gh ENOENT", { executableMissing: true });
      }
      return shellRunCommand(command, args, options);
    });
    await withProjectCreation(runCommand, async (invoke, _storage, root) => {
      const projectPath = path.join(root, "missing-gh");
      await expect(invoke(projectPath)).rejects.toThrow("GitHub CLI is not installed");
      await expect(fs.access(projectPath)).rejects.toThrow();
    });
  });

  test.each([
    ["non-zero failure", new Error("not authenticated")],
    ["timeout", new CommandFailedError("gh timed out", { timedOut: true })],
  ])("preserves the local repository after an ambiguous GitHub creation %s", async (_name, failure) => {
    const runCommand = mock(async (command: string, args: string[] = [], options = {}) => {
      if (command === "gh") throw failure;
      return shellRunCommand(command, args, options);
    });
    await withProjectCreation(runCommand, async (invoke, storage, root) => {
      const projectPath = path.join(root, "ambiguous-gh");
      await expect(invoke(projectPath)).rejects.toThrow("GitHub may have created");
      await fs.access(path.join(projectPath, ".git"));
      expect(await storage.loadProjects()).toEqual([]);
    });
  });

  test.each([
    ["missing origin", "origin"],
    ["push failure", "push"],
  ])("preserves both repositories after %s", async (_name, failurePhase) => {
    const runCommand = mock(async (command: string, args: string[] = [], options = {}) => {
      if (command === "gh" && args[1] === "create") {
        if (failurePhase !== "origin") {
          const source = args.find((arg) => arg.startsWith("--source="))!.slice(9);
          await shellRunCommand("git", [
            "-C", source, "remote", "add", "origin", "https://github.com/owner/project.git",
          ]);
        }
        return { stdout: "", stderr: "" };
      }
      if (command === "git" && args[2] === "remote" && args[3] === "get-url" && failurePhase === "origin") {
        return { stdout: "", stderr: "" };
      }
      if (command === "git" && args[2] === "push") {
        if (failurePhase === "push") throw new Error("push rejected");
        return { stdout: "", stderr: "" };
      }
      return shellRunCommand(command, args, options);
    });
    await withProjectCreation(runCommand, async (invoke, storage, root) => {
      const projectPath = path.join(root, "project");
      await expect(invoke(projectPath)).rejects.toThrow("Add the existing repository instead");
      await fs.access(path.join(projectPath, ".git"));
      expect(await storage.loadProjects()).toEqual([]);
    });
  });

  test("preserves the repositories when project persistence fails", async () => {
    const runCommand = successfulRunner();
    await withProjectCreation(runCommand, async (invoke, storage, root) => {
      storage.addProject = mock(async () => { throw new Error("disk is read-only"); });
      const projectPath = path.join(root, "persist-failure");
      await expect(invoke(projectPath)).rejects.toThrow("disk is read-only");
      await fs.access(path.join(projectPath, ".git"));
    });
  });

  test("serializes two requests for the same canonical path", async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let markFirstInitEntered!: () => void;
    const firstInitEntered = new Promise<void>((resolve) => { markFirstInitEntered = resolve; });
    let markSecondInitEntered!: () => void;
    const secondInitEntered = new Promise<void>((resolve) => { markSecondInitEntered = resolve; });
    let initCalls = 0;
    const base = successfulRunner();
    const runCommand = mock(async (command: string, args: string[] = [], options = {}) => {
      if (command === "git" && args[2] === "init") {
        initCalls += 1;
        if (initCalls === 1) markFirstInitEntered();
        if (initCalls === 2) markSecondInitEntered();
        await gate;
      }
      return base(command, args, options);
    });

    await withProjectCreation(runCommand, async (invoke, storage, root) => {
      const realParent = path.join(root, "real");
      const aliasParent = path.join(root, "alias");
      await fs.mkdir(realParent);
      await fs.symlink(realParent, aliasParent, "dir");
      const first = invoke(path.join(realParent, "shared"));
      await firstInitEntered;
      const second = invoke(path.join(aliasParent, "shared"));
      const pathWasProtected = await remainsPending(secondInitEntered);
      releaseFirst();
      expect(pathWasProtected).toBe(true);
      expect(initCalls).toBe(1);

      await expect(first).resolves.toBeDefined();
      await expect(second).rejects.toThrow("A project already uses this local path");
      expect(initCalls).toBe(1);
      expect(await storage.loadProjects()).toHaveLength(1);
    });
  });

  test("allows different paths to initialize concurrently and persists both", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let bothStarted!: () => void;
    const started = new Promise<void>((resolve) => { bothStarted = resolve; });
    let activeInits = 0;
    let maxActiveInits = 0;
    let initCalls = 0;
    const base = successfulRunner();
    const runCommand = mock(async (command: string, args: string[] = [], options = {}) => {
      if (command === "git" && args[2] === "init") {
        initCalls += 1;
        activeInits += 1;
        maxActiveInits = Math.max(maxActiveInits, activeInits);
        if (initCalls === 2) bothStarted();
        await gate;
        activeInits -= 1;
      }
      return base(command, args, options);
    });

    await withProjectCreation(runCommand, async (invoke, storage, root) => {
      const first = invoke(path.join(root, "first"));
      const second = invoke(path.join(root, "second"));
      await started;
      expect(maxActiveInits).toBe(2);
      release();
      await expect(Promise.all([first, second])).resolves.toHaveLength(2);
      expect(await storage.loadProjects()).toHaveLength(2);
    });
  });
});
