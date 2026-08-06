import { describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCommandRegistry, type CommandContext } from "./commands.js";
import { EnvironmentLifecycleTaskTracker } from "./environment-lifecycle-tasks.js";
import { runCommand as shellRunCommand } from "./shell.js";
import { StorageService } from "./storage.js";

async function withProjectCreation<T>(
  runCommand: typeof shellRunCommand,
  run: (
    invoke: (localPath: string) => Promise<unknown>,
    storage: StorageService,
    root: string,
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

  try {
    return await run(
      (localPath) => Promise.resolve(handler({ localPath }, context)),
      storage,
      root,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("create_project_from_scratch", () => {
  test("creates the folder, initializes main, creates a private origin, and persists it", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runCommand = mock(async (
      command: string,
      args: string[] = [],
      options = {},
    ) => {
      calls.push({ command, args });
      if (command === "gh") {
        const source = args.find((arg) => arg.startsWith("--source="))?.slice(9);
        if (!source) throw new Error("missing source path");
        await shellRunCommand("git", [
          "-C",
          source,
          "remote",
          "add",
          "origin",
          "git@github.com:arkaydeus/blank-canvas.git",
        ]);
        return { stdout: "", stderr: "" };
      }
      return shellRunCommand(command, args, options);
    });

    await withProjectCreation(runCommand, async (invoke, storage, root) => {
      const projectPath = path.join(root, "blank-canvas");
      const project = await invoke(projectPath) as {
        name: string;
        gitUrl: string;
        localPath: string;
      };

      expect(project).toMatchObject({
        name: "blank-canvas",
        gitUrl: "git@github.com:arkaydeus/blank-canvas.git",
        localPath: projectPath,
      });
      expect(calls).toEqual([
        {
          command: "git",
          args: ["-C", projectPath, "init", "-b", "main"],
        },
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
            "--push",
          ],
        },
        {
          command: "git",
          args: ["-C", projectPath, "remote", "get-url", "origin"],
        },
      ]);
      await expect(shellRunCommand(
        "git",
        ["-C", projectPath, "rev-parse", "--verify", "main^{commit}"],
      )).resolves.toMatchObject({ stdout: expect.stringMatching(/^[0-9a-f]{40}\n$/) });
      expect(await storage.loadProjects()).toHaveLength(1);
    });
  });

  test("rejects a non-empty target without running Git or GitHub CLI", async () => {
    const runCommand = mock(async () => ({ stdout: "", stderr: "" }));
    await withProjectCreation(runCommand, async (invoke, _storage, root) => {
      const projectPath = path.join(root, "occupied");
      await fs.mkdir(projectPath);
      await fs.writeFile(path.join(projectPath, "keep.txt"), "mine");

      await expect(invoke(projectPath)).rejects.toThrow(
        "Project path must be new or an empty directory",
      );
      expect(runCommand).not.toHaveBeenCalled();
      await expect(fs.readFile(path.join(projectPath, "keep.txt"), "utf8"))
        .resolves.toBe("mine");
    });
  });

  test("removes only the local folder created by a failed GitHub attempt", async () => {
    const runCommand = mock(async (command: string, args: string[] = []) => {
      if (command === "git" && args[2] === "init") {
        await fs.mkdir(path.join(args[1]!, ".git"));
        return { stdout: "", stderr: "" };
      }
      if (command === "git") return { stdout: "", stderr: "" };
      throw new Error("not authenticated");
    });

    await withProjectCreation(runCommand, async (invoke, storage, root) => {
      const projectPath = path.join(root, "failed-project");
      await expect(invoke(projectPath)).rejects.toThrow(
        "Could not create the private GitHub repository: not authenticated",
      );
      await expect(fs.access(projectPath)).rejects.toThrow();
      expect(await storage.loadProjects()).toEqual([]);
    });
  });

  test("preserves a user-selected empty folder when GitHub creation fails", async () => {
    const runCommand = mock(async (command: string, args: string[] = []) => {
      if (command === "git" && args[2] === "init") {
        await fs.mkdir(path.join(args[1]!, ".git"));
        return { stdout: "", stderr: "" };
      }
      if (command === "git") return { stdout: "", stderr: "" };
      throw new Error("not authenticated");
    });

    await withProjectCreation(runCommand, async (invoke, _storage, root) => {
      const projectPath = path.join(root, "selected-empty-folder");
      await fs.mkdir(projectPath);

      await expect(invoke(projectPath)).rejects.toThrow("not authenticated");
      await expect(fs.readdir(projectPath)).resolves.toEqual([]);
    });
  });

  test("requires an absolute target path", async () => {
    const runCommand = mock(async () => ({ stdout: "", stderr: "" }));
    await withProjectCreation(runCommand, async (invoke) => {
      await expect(invoke("relative/project")).rejects.toThrow(
        "Project path must be an absolute path",
      );
      expect(runCommand).not.toHaveBeenCalled();
    });
  });
});
