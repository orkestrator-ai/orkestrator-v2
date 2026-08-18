import { describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCommandRegistry, type CommandContext } from "./commands.js";
import { EnvironmentLifecycleTaskTracker } from "./environment-lifecycle-tasks.js";
import type { Project } from "./models.js";
import { CommandFailedError, runCommand as shellRunCommand } from "./shell.js";
import { StorageService } from "./storage.js";

type Run = typeof shellRunCommand;

async function withProjectCreation<T>(
  runCommand: Run,
  run: (
    invoke: (localPath: string) => Promise<unknown>,
    storage: StorageService,
    root: string,
    invokeArgs: (args: Record<string, unknown>) => Promise<unknown>,
    invokeCommand: (name: string, args: Record<string, unknown>) => Promise<unknown>,
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
  const invokeCommand = async (name: string, args: Record<string, unknown>) => {
    const command = commands.get(name);
    if (!command) throw new Error(`${name} is not registered`);
    return command(args, context);
  };

  try {
    return await run(
      (localPath) => invokeArgs({ localPath }),
      storage,
      root,
      invokeArgs,
      invokeCommand,
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
        "-C",
        source,
        "remote",
        "add",
        "origin",
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
    promise.then(
      () => false,
      () => false,
    ),
    new Promise<true>((resolve) => setTimeout(() => resolve(true), timeoutMs)),
  ]);
}

describe("create_project_from_scratch", () => {
  test("creates, verifies, pushes, and persists a private repository in separate phases", async () => {
    const calls: Array<{ command: string; args: string[]; timeoutMs?: number }> = [];
    const runCommand = successfulRunner(calls);

    await withProjectCreation(runCommand, async (invoke, storage, root) => {
      const projectPath = path.join(root, "blank-canvas");
      const project = (await invoke(projectPath)) as {
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
            "-C",
            projectPath,
            "-c",
            "user.name=Orkestrator",
            "-c",
            "user.email=projects@orkestrator.local",
            "commit",
            "--allow-empty",
            "--no-gpg-sign",
            "-m",
            "Initial commit",
          ],
          timeoutMs: 30_000,
        },
        {
          command: "gh",
          args: [
            "repo",
            "create",
            "blank-canvas",
            "--private",
            `--source=${projectPath}`,
            "--remote=origin",
          ],
          timeoutMs: 120_000,
        },
        {
          command: "git",
          args: ["-C", projectPath, "config", "--get", "remote.origin.url"],
          timeoutMs: 10_000,
        },
        {
          command: "git",
          args: ["-C", projectPath, "push", "--set-upstream", "origin", "main"],
          timeoutMs: 120_000,
        },
      ]);
      await expect(
        shellRunCommand("git", ["-C", projectPath, "rev-parse", "--verify", "main^{commit}"]),
      ).resolves.toMatchObject({ stdout: expect.stringMatching(/^[0-9a-f]{40}\n$/) });
      expect(await storage.loadProjects()).toHaveLength(1);
    });
  });

  test("rejects blank, unknown, relative, root, file, symlink, and non-empty targets", async () => {
    const runCommand = mock(async () => ({ stdout: "", stderr: "" }));
    await withProjectCreation(runCommand, async (invoke, _storage, root, invokeArgs) => {
      await expect(invokeArgs({ localPath: " " })).rejects.toThrow(/non-blank string/);
      await expect(invokeArgs({ localPath: path.join(root, "new"), extra: true })).rejects.toThrow(
        "Unexpected arguments field: extra",
      );
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

  test.each([
    ["double dash", "--public"],
    ["single dash", "-x"],
  ])("rejects a leading-dash repository name (%s) before invoking a CLI", async (_name, folder) => {
    const runCommand = mock(async () => ({ stdout: "", stderr: "" }));
    await withProjectCreation(runCommand, async (invoke, _storage, root) => {
      await expect(invoke(path.join(root, folder))).rejects.toThrow("cannot begin with a dash");
      expect(runCommand).not.toHaveBeenCalled();
    });
  });

  test("add_project rejects a local path an existing project already uses", async () => {
    const runCommand = successfulRunner();
    await withProjectCreation(runCommand, async (invoke, storage, root, _args, invokeCommand) => {
      const projectPath = path.join(root, "shared-path");
      await invoke(projectPath);

      await expect(
        invokeCommand("add_project", {
          gitUrl: "https://example.invalid/other.git",
          localPath: projectPath,
        }),
      ).rejects.toThrow("A project already uses this local path");
      expect(await storage.loadProjects()).toHaveLength(1);
    });
  });

  test("add_project still accepts a project without a local path", async () => {
    const runCommand = mock(async () => ({ stdout: "", stderr: "" }));
    await withProjectCreation(runCommand, async (_invoke, storage, _root, _args, invokeCommand) => {
      await invokeCommand("add_project", { gitUrl: "https://example.invalid/a.git" });
      await invokeCommand("add_project", { gitUrl: "https://example.invalid/b.git" });
      expect(await storage.loadProjects()).toHaveLength(2);
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
    [
      "missing Git",
      new CommandFailedError("spawn git ENOENT", { executableMissing: true }),
      "Git is not installed",
    ],
    [
      "Git init timeout",
      new CommandFailedError("init timed out", { timedOut: true }),
      "init timed out",
    ],
  ])("rolls back a new directory after %s", async (_name, failure, expected) => {
    const runCommand = mock(async () => {
      throw failure;
    });
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
      await expect(invoke(projectPath)).rejects.toThrow(
        "Could not create the initial Git commit: commit timed out",
      );
      await expect(fs.readFile(path.join(projectPath, "appeared.txt"), "utf8")).resolves.toBe(
        "keep",
      );
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
  ])(
    "preserves the local repository after an ambiguous GitHub creation %s",
    async (_name, failure) => {
      const runCommand = mock(async (command: string, args: string[] = [], options = {}) => {
        if (command === "gh") throw failure;
        return shellRunCommand(command, args, options);
      });
      await withProjectCreation(runCommand, async (invoke, storage, root) => {
        const projectPath = path.join(root, "ambiguous-gh");
        const error = await invoke(projectPath).catch((thrown: Error) => thrown);
        expect((error as Error).message).toContain("GitHub may have created");
        expect((error as Error).message).toContain(failure.message);
        await fs.access(path.join(projectPath, ".git"));
        // The preserved repository must still hold the commit that makes it
        // resumable, not just an empty .git directory.
        await expect(
          shellRunCommand("git", ["-C", projectPath, "log", "-1", "--format=%an%n%s"]),
        ).resolves.toMatchObject({ stdout: "Orkestrator\nInitial commit\n" });
        expect(await storage.loadProjects()).toEqual([]);
      });
    },
  );

  test.each([
    ["missing origin", "origin", "Could not verify the origin remote"],
    ["unreadable origin", "origin-throws", "no such key"],
    ["push failure", "push", "push rejected"],
  ])("preserves both repositories after %s", async (_name, failurePhase, expectedDetail) => {
    const runCommand = mock(async (command: string, args: string[] = [], options = {}) => {
      if (command === "gh" && args[1] === "create") {
        if (failurePhase === "push") {
          const source = args.find((arg) => arg.startsWith("--source="))!.slice(9);
          await shellRunCommand("git", [
            "-C",
            source,
            "remote",
            "add",
            "origin",
            "https://github.com/owner/project.git",
          ]);
        }
        return { stdout: "", stderr: "" };
      }
      if (command === "git" && args[2] === "config") {
        if (failurePhase === "origin") return { stdout: "", stderr: "" };
        if (failurePhase === "origin-throws") throw new Error("no such key");
      }
      if (command === "git" && args[2] === "push") {
        if (failurePhase === "push") throw new Error("push rejected");
        return { stdout: "", stderr: "" };
      }
      return shellRunCommand(command, args, options);
    });
    await withProjectCreation(runCommand, async (invoke, storage, root) => {
      const projectPath = path.join(root, "project");
      const failure = await invoke(projectPath).catch((error: Error) => error);
      // Both the wrapper and the underlying reason must survive: the wrapper
      // alone would hide which phase failed.
      expect((failure as Error).message).toContain("Add the existing repository instead");
      expect((failure as Error).message).toContain(expectedDetail);
      await fs.access(path.join(projectPath, ".git"));
      expect(await storage.loadProjects()).toEqual([]);
    });
  });

  test("preserves the repositories when project persistence fails", async () => {
    const runCommand = successfulRunner();
    await withProjectCreation(runCommand, async (invoke, storage, root) => {
      storage.addProject = mock(async () => {
        throw new Error("disk is read-only");
      });
      const projectPath = path.join(root, "persist-failure");
      const failure = await invoke(projectPath).catch((error: Error) => error);
      expect((failure as Error).message).toContain("Add the existing repository instead");
      expect((failure as Error).message).toContain("disk is read-only");
      await fs.access(path.join(projectPath, ".git"));
    });
  });

  test("reads the configured origin rather than the insteadOf-rewritten URL", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runCommand = mock(async (command: string, args: string[] = [], options = {}) => {
      calls.push({ command, args });
      if (command === "gh") return { stdout: "", stderr: "" };
      if (command === "git" && args[2] === "config") {
        return { stdout: "https://github.com/test/plain.git\n", stderr: "" };
      }
      if (command === "git" && args[2] === "push") return { stdout: "", stderr: "" };
      return shellRunCommand(command, args, options);
    });
    await withProjectCreation(runCommand, async (invoke, storage, root) => {
      await invoke(path.join(root, "plain"));
      expect(calls.some(({ args }) => args.includes("get-url"))).toBe(false);
      expect(await storage.loadProjects()).toMatchObject([
        { gitUrl: "https://github.com/test/plain.git" },
      ]);
    });
  });

  test.each([
    [
      "password userinfo",
      "https://x-token:SECRET@github.com/test/x.git",
      "https://github.com/test/x.git",
    ],
    [
      "bare token userinfo",
      "https://SECRET@github.com/test/x.git",
      "https://github.com/test/x.git",
    ],
    ["scp syntax is untouched", "git@github.com:test/x.git", "git@github.com:test/x.git"],
    ["ssh url userinfo", "ssh://git:SECRET@github.com/test/x.git", "ssh://github.com/test/x.git"],
  ])(
    "strips credentials from the persisted origin URL (%s)",
    async (_name, configured, expected) => {
      const runCommand = mock(async (command: string, args: string[] = [], options = {}) => {
        if (command === "gh") return { stdout: "", stderr: "" };
        if (command === "git" && args[2] === "config")
          return { stdout: `${configured}\n`, stderr: "" };
        if (command === "git" && args[2] === "push") return { stdout: "", stderr: "" };
        return shellRunCommand(command, args, options);
      });
      await withProjectCreation(runCommand, async (invoke, storage, root) => {
        await invoke(path.join(root, "credential"));
        const [project] = await storage.loadProjects();
        expect(project!.gitUrl).toBe(expected);
        expect(project!.gitUrl).not.toContain("SECRET");
      });
    },
  );

  test("reports an ancestor that is a regular file as a directory problem", async () => {
    const runCommand = mock(async () => ({ stdout: "", stderr: "" }));
    await withProjectCreation(runCommand, async (invoke, _storage, root) => {
      const blocker = path.join(root, "blocker");
      await fs.writeFile(blocker, "data");
      // lstat answers ENOTDIR here, not ENOENT; the user must not see an errno.
      const failure = await invoke(path.join(blocker, "project")).catch((error: Error) => error);
      expect((failure as Error).message).toBe(
        "Project path must be a directory and cannot be a symbolic link",
      );
      expect((failure as Error).message).not.toContain("ENOTDIR");
      expect(runCommand).not.toHaveBeenCalled();
    });
  });

  test("removes intermediate directories it created when rolling back", async () => {
    const runCommand = mock(async () => {
      throw new CommandFailedError("init timed out", { timedOut: true });
    });
    await withProjectCreation(runCommand, async (invoke, _storage, root) => {
      const createdRoot = path.join(root, "made");
      const projectPath = path.join(createdRoot, "nested", "deep", "project");
      await expect(invoke(projectPath)).rejects.toThrow("init timed out");
      // mkdir reports the topmost directory it created, so rollback has to walk
      // back up rather than removing the leaf alone.
      await expect(fs.access(createdRoot)).rejects.toThrow();
      await fs.access(root);
    });
  });

  test("keeps intermediate directories that were not empty", async () => {
    let initialized = false;
    const runCommand = mock(async (command: string, args: string[] = [], options = {}) => {
      if (command === "git" && args[2] === "init" && !initialized) {
        initialized = true;
        const result = await shellRunCommand(command, args, options);
        await fs.writeFile(path.join(path.dirname(args[1]!), "sibling.txt"), "keep");
        return result;
      }
      throw new CommandFailedError("commit timed out", { timedOut: true });
    });
    await withProjectCreation(runCommand, async (invoke, _storage, root) => {
      const createdRoot = path.join(root, "made");
      const projectPath = path.join(createdRoot, "project");
      await expect(invoke(projectPath)).rejects.toThrow("commit timed out");
      await expect(fs.access(projectPath)).rejects.toThrow();
      await expect(fs.readFile(path.join(createdRoot, "sibling.txt"), "utf8")).resolves.toBe(
        "keep",
      );
    });
  });

  test("keeps a pre-existing empty directory and removes only its Git metadata", async () => {
    const runCommand = mock(async (command: string, args: string[] = [], options = {}) => {
      if (command === "git" && args[2] === "init") return shellRunCommand(command, args, options);
      throw new CommandFailedError("commit timed out", { timedOut: true });
    });
    await withProjectCreation(runCommand, async (invoke, _storage, root) => {
      const projectPath = path.join(root, "user-folder");
      await fs.mkdir(projectPath);
      await expect(invoke(projectPath)).rejects.toThrow("commit timed out");
      // The user made this folder; rollback owns only what it created inside it.
      await fs.access(projectPath);
      expect(await fs.readdir(projectPath)).toEqual([]);
    });
  });

  test("creates a project inside a pre-existing empty directory", async () => {
    const runCommand = successfulRunner();
    await withProjectCreation(runCommand, async (invoke, storage, root) => {
      const projectPath = path.join(root, "prepared");
      await fs.mkdir(projectPath);
      await expect(invoke(projectPath)).resolves.toMatchObject({ localPath: projectPath });
      expect(await storage.loadProjects()).toHaveLength(1);
    });
  });

  test("declines to roll back through an ancestor swapped for a symlink", async () => {
    let sharedParent = "";
    let victim = "";
    const runCommand = mock(async (command: string, args: string[] = [], options = {}) => {
      if (command === "git" && args[2] === "init") {
        const result = await shellRunCommand(command, args, options);
        // The leaf is still a real directory afterwards, so the leaf-only
        // symlink check cannot see this; only the recorded identity can.
        await fs.rm(sharedParent, { recursive: true, force: true });
        await fs.symlink(victim, sharedParent, "dir");
        return result;
      }
      throw new CommandFailedError("commit timed out", { timedOut: true });
    });
    await withProjectCreation(runCommand, async (invoke, _storage, root) => {
      sharedParent = path.join(root, "shared");
      victim = path.join(root, "victim");
      await fs.mkdir(path.join(victim, "proj"), { recursive: true });
      await fs.mkdir(path.join(victim, "proj", ".git"));
      await fs.writeFile(path.join(victim, "proj", ".git", "precious"), "mine");

      await expect(invoke(path.join(sharedParent, "proj"))).rejects.toThrow("commit timed out");
      await expect(
        fs.readFile(path.join(victim, "proj", ".git", "precious"), "utf8"),
      ).resolves.toBe("mine");
    });
  });

  test("resumes a preserved scratch repository after an ambiguous GitHub failure", async () => {
    let failGh = true;
    const base = successfulRunner();
    const runCommand = mock(async (command: string, args: string[] = [], options = {}) => {
      if (command === "gh" && failGh) throw new Error("not authenticated");
      return base(command, args, options);
    });

    await withProjectCreation(runCommand, async (invoke, storage, root) => {
      const projectPath = path.join(root, "resumable");
      await expect(invoke(projectPath)).rejects.toThrow("retry the same path to resume");
      await fs.access(path.join(projectPath, ".git"));

      failGh = false;
      await expect(invoke(projectPath)).resolves.toMatchObject({ localPath: projectPath });
      expect(await storage.loadProjects()).toHaveLength(1);
      // Resuming must not re-init or re-commit on top of the preserved repo.
      await expect(
        shellRunCommand("git", ["-C", projectPath, "rev-list", "--count", "HEAD"]),
      ).resolves.toMatchObject({ stdout: "1\n" });
    });
  });

  test.each([
    [
      "a foreign repository",
      async (projectPath: string) => {
        await shellRunCommand("git", ["-C", projectPath, "init", "-b", "main"]);
        await shellRunCommand("git", [
          "-C",
          projectPath,
          "-c",
          "user.name=Someone",
          "-c",
          "user.email=someone@example.invalid",
          "commit",
          "--allow-empty",
          "--no-gpg-sign",
          "-m",
          "Their work",
        ]);
      },
    ],
    [
      "a repository that already has a remote",
      async (projectPath: string) => {
        await shellRunCommand("git", ["-C", projectPath, "init", "-b", "main"]);
        await shellRunCommand("git", [
          "-C",
          projectPath,
          "-c",
          "user.name=Orkestrator",
          "-c",
          "user.email=projects@orkestrator.local",
          "commit",
          "--allow-empty",
          "--no-gpg-sign",
          "-m",
          "Initial commit",
        ]);
        await shellRunCommand("git", [
          "-C",
          projectPath,
          "remote",
          "add",
          "origin",
          "https://example.invalid/x.git",
        ]);
      },
    ],
    [
      "a repository with extra commits",
      async (projectPath: string) => {
        await shellRunCommand("git", ["-C", projectPath, "init", "-b", "main"]);
        for (const message of ["Initial commit", "More work"]) {
          await shellRunCommand("git", [
            "-C",
            projectPath,
            "-c",
            "user.name=Orkestrator",
            "-c",
            "user.email=projects@orkestrator.local",
            "commit",
            "--allow-empty",
            "--no-gpg-sign",
            "-m",
            message,
          ]);
        }
      },
    ],
  ])("refuses to resume %s", async (_name, prepare) => {
    const base = successfulRunner();
    const runCommand = mock(async (command: string, args: string[] = [], options = {}) =>
      base(command, args, options),
    );
    await withProjectCreation(runCommand, async (invoke, storage, root) => {
      const projectPath = path.join(root, "occupied-repo");
      await fs.mkdir(projectPath);
      await prepare(projectPath);

      await expect(invoke(projectPath)).rejects.toThrow("new or an empty directory");
      // A refusal must never delete the repository it declined to adopt.
      await fs.access(path.join(projectPath, ".git"));
      expect(await storage.loadProjects()).toEqual([]);
    });
  });

  test("refuses to resume a scratch repository with working-tree content", async () => {
    const runCommand = successfulRunner();
    await withProjectCreation(runCommand, async (invoke, _storage, root) => {
      const projectPath = path.join(root, "dirty-repo");
      await fs.mkdir(projectPath);
      await shellRunCommand("git", ["-C", projectPath, "init", "-b", "main"]);
      await shellRunCommand("git", [
        "-C",
        projectPath,
        "-c",
        "user.name=Orkestrator",
        "-c",
        "user.email=projects@orkestrator.local",
        "commit",
        "--allow-empty",
        "--no-gpg-sign",
        "-m",
        "Initial commit",
      ]);
      await fs.writeFile(path.join(projectPath, "draft.txt"), "mine");

      await expect(invoke(projectPath)).rejects.toThrow("new or an empty directory");
      await expect(fs.readFile(path.join(projectPath, "draft.txt"), "utf8")).resolves.toBe("mine");
    });
  });

  test("detects a duplicate canonical path when the stored project used the alias", async () => {
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
        localPath: path.join(aliasParent, "new"),
        addedAt: new Date(0).toISOString(),
        order: 0,
      } satisfies Project);

      await expect(invoke(path.join(realParent, "new"))).rejects.toThrow(
        "A project already uses this local path",
      );
      expect(runCommand).not.toHaveBeenCalled();
    });
  });

  test("ignores an existing project whose local path can no longer be resolved", async () => {
    const runCommand = successfulRunner();
    await withProjectCreation(runCommand, async (invoke, storage, root) => {
      await storage.addProject({
        id: "stale",
        name: "stale",
        gitUrl: "https://example.invalid/stale.git",
        localPath: path.join(root, "moved-away", "project"),
        addedAt: new Date(0).toISOString(),
        order: 0,
      } satisfies Project);

      await expect(invoke(path.join(root, "fresh"))).resolves.toBeDefined();
      expect(await storage.loadProjects()).toHaveLength(2);
    });
  });

  test("rejects a duplicate local path inserted while the CLI work was running", async () => {
    let releaseGh!: () => void;
    const ghGate = new Promise<void>((resolve) => {
      releaseGh = resolve;
    });
    let markGhEntered!: () => void;
    const ghEntered = new Promise<void>((resolve) => {
      markGhEntered = resolve;
    });
    const base = successfulRunner();
    const runCommand = mock(async (command: string, args: string[] = [], options = {}) => {
      if (command === "gh") {
        markGhEntered();
        await ghGate;
      }
      return base(command, args, options);
    });

    await withProjectCreation(runCommand, async (invoke, storage, root) => {
      const projectPath = path.join(root, "contested");
      const creation = invoke(projectPath);
      await ghEntered;
      // The early scan already passed; only the guard inside addProject's
      // critical section can still catch this.
      await storage.addProject({
        id: "sneaked-in",
        name: "sneaked-in",
        gitUrl: "https://example.invalid/sneaked-in.git",
        localPath: projectPath,
        addedAt: new Date(0).toISOString(),
        order: 0,
      } satisfies Project);
      releaseGh();

      await expect(creation).rejects.toThrow("A project already uses this local path");
      expect(await storage.loadProjects()).toHaveLength(1);
    });
  });

  test("serializes two requests for the same canonical path", async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstInitEntered!: () => void;
    const firstInitEntered = new Promise<void>((resolve) => {
      markFirstInitEntered = resolve;
    });
    let markSecondInitEntered!: () => void;
    const secondInitEntered = new Promise<void>((resolve) => {
      markSecondInitEntered = resolve;
    });
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

  test("serializes two requests whose paths differ only in case", async () => {
    const probeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ork-case-probe-"));
    let caseInsensitive = false;
    try {
      await fs.mkdir(path.join(probeRoot, "Probe"));
      caseInsensitive = await fs.access(path.join(probeRoot, "probe")).then(
        () => true,
        () => false,
      );
    } finally {
      await fs.rm(probeRoot, { recursive: true, force: true });
    }
    if (!caseInsensitive) return;

    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstInitEntered!: () => void;
    const firstInitEntered = new Promise<void>((resolve) => {
      markFirstInitEntered = resolve;
    });
    let markSecondInitEntered!: () => void;
    const secondInitEntered = new Promise<void>((resolve) => {
      markSecondInitEntered = resolve;
    });
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
      const first = invoke(path.join(root, "CasedProject"));
      await firstInitEntered;
      // The same physical directory on a case-insensitive volume, so a
      // case-preserving lock key would let both calls init at once and the
      // loser's rollback would delete the winner's .git.
      const second = invoke(path.join(root, "casedproject"));
      const pathWasProtected = await remainsPending(secondInitEntered);
      releaseFirst();
      expect(pathWasProtected).toBe(true);

      await expect(first).resolves.toBeDefined();
      await expect(second).rejects.toThrow("A project already uses this local path");
      expect(initCalls).toBe(1);
      expect(await storage.loadProjects()).toHaveLength(1);
    });
  });

  test("allows different paths to initialize concurrently and persists both", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let bothStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      bothStarted = resolve;
    });
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
      // A regression that serialized distinct paths would leave `started`
      // pending forever, so bound the wait and assert rather than hang.
      const bothEntered = await Promise.race([
        started.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
      ]);
      release();
      expect(bothEntered).toBe(true);
      expect(maxActiveInits).toBe(2);
      await expect(Promise.all([first, second])).resolves.toHaveLength(2);
      expect(await storage.loadProjects()).toHaveLength(2);
    });
  });
});
