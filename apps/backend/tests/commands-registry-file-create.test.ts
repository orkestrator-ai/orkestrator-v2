import { describe, expect, mock, test } from "bun:test";
import { createCommandFixtures } from "./command-fixtures";

const {
  createCommandRegistry,
  createContext,
  createEnvironment,
  createGitWorktreeWithOrigin,
  fs,
  path,
} = await createCommandFixtures();

type RunCommand = typeof import("../src/core/shell").runCommand;

describe("create_local_file / create_container_file", () => {
  test("creates empty local files and never replaces an existing one", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    const commands = createCommandRegistry();
    const environment = createEnvironment({ worktreePath: worktree });
    const { context } = createContext(environment);
    const create = commands.get("create_local_file");
    if (!create) throw new Error("create_local_file command is not registered");

    await fs.mkdir(path.join(worktree, "docs"));
    await expect(
      create({ environmentId: environment.id, parentDirectory: "docs", fileName: "a.md" }, context),
    ).resolves.toBe("docs/a.md");
    expect(await fs.readFile(path.join(worktree, "docs", "a.md"), "utf8")).toBe("");
    await expect(
      create({ environmentId: environment.id, parentDirectory: ".", fileName: "b.txt" }, context),
    ).resolves.toBe("b.txt");
    expect(await fs.readFile(path.join(worktree, "b.txt"), "utf8")).toBe("");

    await fs.writeFile(path.join(worktree, "docs", "keep.md"), "keep me\n");
    await expect(
      create(
        { environmentId: environment.id, parentDirectory: "docs", fileName: "keep.md" },
        context,
      ),
    ).rejects.toThrow("A file or folder already exists at docs/keep.md");
    expect(await fs.readFile(path.join(worktree, "docs", "keep.md"), "utf8")).toBe("keep me\n");

    await expect(
      create(
        { environmentId: environment.id, parentDirectory: ".", fileName: "../outside" },
        context,
      ),
    ).rejects.toThrow("path separators are not allowed");
    await expect(
      create({ environmentId: environment.id, parentDirectory: ".", fileName: "  " }, context),
    ).rejects.toThrow("name is required");
    await expect(
      create(
        { environmentId: environment.id, parentDirectory: ".git", fileName: "config2" },
        context,
      ),
    ).rejects.toThrow("Git metadata cannot be modified");
    await expect(
      create(
        { environmentId: environment.id, parentDirectory: "docs", fileName: undefined },
        context,
      ),
    ).rejects.toThrow("Expected fileName to be a string");
  });

  test("creates container files through the pinned exclusive writer", async () => {
    const environment = createEnvironment({
      id: "env-container-create-file",
      environmentType: "containerized",
      containerId: "container-create-file-1",
      status: "running",
    });
    const { context } = createContext(environment);
    const invocations: Array<{
      command: string;
      args: string[];
      options: { stdin?: string | Buffer; timeoutMs?: number };
    }> = [];
    const runner = mock(async (command: string, args: string[], options = {}) => {
      invocations.push({ command, args, options });
      if (args[8] === "exists.txt") throw new Error("EEXIST");
      if (args[7] === "missing") throw new Error("ENOENT_ANCESTOR");
      if (args[8] === "failed.txt") throw new Error("docker unavailable");
      return { stdout: "", stderr: "" };
    });
    const commands = createCommandRegistry({
      containerFileCopy: { runCommand: runner as unknown as RunCommand },
    });
    const create = commands.get("create_container_file");
    if (!create) throw new Error("create_container_file command is not registered");

    await expect(
      create(
        { environmentId: environment.id, parentDirectory: "src", fileName: " new.ts " },
        context,
      ),
    ).resolves.toBe("src/new.ts");
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({ command: "docker", options: { timeoutMs: 120_000 } });
    expect(invocations[0]!.options.stdin).toBeUndefined();
    expect(invocations[0]!.args.slice(0, 5)).toEqual([
      "exec",
      "-i",
      "container-create-file-1",
      "node",
      "-e",
    ]);
    expect(invocations[0]!.args.slice(6)).toEqual([
      "/workspace",
      "src",
      "new.ts",
      "0",
      "",
      "exclusive",
      String(0o644),
      "existing",
    ]);

    await expect(
      create(
        { environmentId: environment.id, parentDirectory: "src", fileName: "exists.txt" },
        context,
      ),
    ).rejects.toThrow("A file or folder already exists at src/exists.txt");
    await expect(
      create(
        { environmentId: environment.id, parentDirectory: "missing", fileName: "a.txt" },
        context,
      ),
    ).rejects.toThrow("Parent directory does not exist: missing");
    await expect(
      create(
        { environmentId: environment.id, parentDirectory: "src", fileName: "failed.txt" },
        context,
      ),
    ).rejects.toThrow("The file could not be created in the container workspace");

    const before = invocations.length;
    await expect(
      create(
        { environmentId: environment.id, parentDirectory: "../outside", fileName: "a.txt" },
        context,
      ),
    ).rejects.toThrow("Invalid parentDirectory");
    await expect(
      create({ environmentId: environment.id, parentDirectory: ".", fileName: ".GIT" }, context),
    ).rejects.toThrow("Git metadata cannot be modified");
    expect(invocations).toHaveLength(before);
  });

  test("refuses a local environment for the container command and the reverse", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    const local = createEnvironment({ worktreePath: worktree });
    const commands = createCommandRegistry();
    await expect(
      commands.get("create_container_file")!(
        { environmentId: local.id, parentDirectory: ".", fileName: "a.txt" },
        createContext(local).context,
      ),
    ).rejects.toThrow("Environment is not containerized");
    const container = createEnvironment({
      id: "env-container-create-file-2",
      environmentType: "containerized",
      containerId: "container-create-file-2",
      status: "running",
    });
    await expect(
      commands.get("create_local_file")!(
        { environmentId: container.id, parentDirectory: ".", fileName: "a.txt" },
        createContext(container).context,
      ),
    ).rejects.toThrow("Environment is not a local worktree");
  });
});
