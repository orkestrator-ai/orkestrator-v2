import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CONTAINER_PINNED_ATTACHMENT_WRITE,
  copyExternalFileToLocalWorkspace,
  resolveWorkspaceExternalFileCopy,
} from "./files.js";
import { createCommandRegistry } from "./registry.js";
import type { CommandContext } from "./context.js";
import { BackendRuntime } from "../backend-runtime.js";
import type { ArgsOf } from "@orkestrator/protocol/contract/command";
import type { importExternalEntryCommand } from "@orkestrator/protocol/contract/domains/files";
import { runCommand } from "../shell.js";

type ImportAction = ArgsOf<typeof importExternalEntryCommand>["action"];

describe("external workspace file copies", () => {
  let worktreePath = "";
  let runtime: BackendRuntime;

  beforeEach(async () => {
    worktreePath = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-file-copy-"));
    runtime = new BackendRuntime({ emit: () => undefined });
    await fs.mkdir(path.join(worktreePath, "assets"));
  });

  afterEach(async () => {
    runtime.shutdown();
    await fs.rm(worktreePath, { recursive: true, force: true });
  });

  test("copies binary and empty files into an existing local-worktree directory", async () => {
    const binary = Buffer.from([0, 1, 2, 127, 255]);

    await expect(
      copyExternalFileToLocalWorkspace(
        worktreePath,
        "assets",
        "image.bin",
        binary.toString("base64"),
      ),
    ).resolves.toBe("assets/image.bin");
    await expect(fs.readFile(path.join(worktreePath, "assets", "image.bin"))).resolves.toEqual(
      binary,
    );

    await expect(
      copyExternalFileToLocalWorkspace(worktreePath, ".", "empty.txt", ""),
    ).resolves.toBe("empty.txt");
    await expect(fs.readFile(path.join(worktreePath, "empty.txt"))).resolves.toEqual(
      Buffer.alloc(0),
    );
  });

  test("registers an environment-aware command that decodes the renderer payload", async () => {
    const command = createCommandRegistry().get("copy_external_file");
    if (!command) throw new Error("copy_external_file command is not registered");
    const context = {
      storage: {
        getEnvironment: async () => ({
          id: "environment-1",
          environmentType: "local",
          worktreePath,
        }),
      },
      runtime,
    } as unknown as CommandContext;

    await expect(
      command(
        {
          environmentId: "environment-1",
          destinationDirectory: "assets",
          fileName: "from-finder.txt",
          base64Data: Buffer.from("copied through the command").toString("base64"),
        },
        context,
      ),
    ).resolves.toBe("assets/from-finder.txt");
    await expect(
      fs.readFile(path.join(worktreePath, "assets", "from-finder.txt"), "utf8"),
    ).resolves.toBe("copied through the command");
  });

  test("stages a literal folder tree and publishes it exclusively, with a clean retry after discard", async () => {
    await runCommand("git", ["init", "-q"], { cwd: worktreePath });
    const command = createCommandRegistry().get("import_external_entry")!;
    const context = {
      storage: {
        getEnvironment: async () => ({
          id: "environment-1",
          environmentType: "local",
          worktreePath,
        }),
      },
      runtime,
    } as unknown as CommandContext;
    const target = { kind: "local", identity: worktreePath };
    const mutate = (action: ImportAction) =>
      command({ environmentId: "environment-1", target, action }, context);
    const name = " photos ";
    const stage = () => mutate({ kind: "stage", directory: "assets", name }) as Promise<string>;
    const publish = (stagingPath: string) => mutate({ kind: "publish", stagingPath, name });
    const existing = path.join(worktreePath, "assets", name);
    const trimmed = path.join(worktreePath, "assets", "photos");
    await fs.mkdir(existing);
    await fs.mkdir(trimmed);
    await fs.writeFile(path.join(existing, "existing.txt"), "original");
    const conflict = await stage();
    await mutate({ kind: "copy", directory: conflict, name: "new.txt", base64Data: "QQ==" });
    await expect(publish(conflict)).rejects.toThrow("already exists");
    await expect(fs.readdir(existing)).resolves.toEqual(["existing.txt"]);
    await expect(fs.readdir(trimmed)).resolves.toEqual([]);
    await mutate({ kind: "discard", stagingPath: conflict });
    await expect(fs.stat(path.join(worktreePath, conflict))).rejects.toMatchObject({
      code: "ENOENT",
    });

    // An interrupted upload leaves only its private stage, and the same root can be retried.
    await fs.rm(existing, { recursive: true });
    const interrupted = await stage();
    await mutate({ kind: "mkdir", directory: interrupted, name: " empty " });
    await expect(
      mutate({
        kind: "copy",
        directory: interrupted,
        name: "new.txt",
        base64Data: "bad!",
      }),
    ).rejects.toThrow();
    await mutate({ kind: "discard", stagingPath: interrupted });
    await expect(fs.stat(existing)).rejects.toMatchObject({ code: "ENOENT" });
    const retry = await stage();
    await expect(mutate({ kind: "mkdir", directory: retry, name: " empty " })).resolves.toBe(
      `${retry}/ empty `,
    );
    await mutate({ kind: "copy", directory: retry, name: " new.txt ", base64Data: "QQ==" });
    await expect(publish(retry)).resolves.toBe("assets/ photos ");
    await expect(fs.readdir(path.join(existing, " empty "))).resolves.toEqual([]);
    await expect(fs.readFile(path.join(existing, " new.txt "), "utf8")).resolves.toBe("A");
    await expect(fs.readdir(trimmed)).resolves.toEqual([]);
  });

  test("checks the original checkout after project-home reconciliation on each command", async () => {
    const other = path.join(worktreePath, "other-checkout");
    await fs.mkdir(other);
    for (const checkout of [worktreePath, other]) {
      await runCommand("git", ["init", "-q", "-b", "main"], { cwd: checkout });
    }
    let localPath = worktreePath;
    const environment = {
      id: "environment-1",
      projectId: "project-1",
      projectHome: true,
      environmentType: "local",
      worktreePath,
      branch: "main",
    };
    const context = {
      storage: {
        getEnvironment: async () => environment,
        getProject: async () => ({ localPath }),
        updateEnvironment: async (_id: string, update: object) =>
          Object.assign(environment, update),
      },
      runtime,
    } as unknown as CommandContext;
    const command = createCommandRegistry().get("import_external_entry")!;
    const mutate = (action: ImportAction) =>
      command(
        {
          environmentId: environment.id,
          target: { kind: "local", identity: worktreePath },
          action,
        },
        context,
      );
    const stage = (await mutate({ kind: "stage", directory: ".", name: "photos" })) as string;
    // The same relative staging path in B must stay untouched.
    await fs.mkdir(path.join(other, stage));
    localPath = other;
    await expect(
      mutate({ kind: "copy", directory: stage, name: "wrong.txt", base64Data: "QQ==" }),
    ).rejects.toThrow("The project checkout changed");
    await expect(mutate({ kind: "publish", stagingPath: stage, name: "photos" })).rejects.toThrow(
      "The project checkout changed",
    );
    await expect(mutate({ kind: "discard", stagingPath: stage })).rejects.toThrow(
      "The project checkout changed",
    );
    await expect(fs.readdir(path.join(other, stage))).resolves.toEqual([]);
    await expect(fs.stat(path.join(other, "photos"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("does not overwrite a destination or recreate a folder removed after the tree was shown", async () => {
    await fs.writeFile(path.join(worktreePath, "assets", "notes.txt"), "existing");

    await expect(
      copyExternalFileToLocalWorkspace(
        worktreePath,
        "assets",
        "notes.txt",
        Buffer.from("replacement").toString("base64"),
      ),
    ).rejects.toThrow("A file already exists at assets/notes.txt");
    await expect(fs.readFile(path.join(worktreePath, "assets", "notes.txt"), "utf8")).resolves.toBe(
      "existing",
    );

    await fs.rm(path.join(worktreePath, "assets"), { recursive: true });
    await expect(
      copyExternalFileToLocalWorkspace(worktreePath, "assets", "notes.txt", "bmV3"),
    ).rejects.toThrow("Destination directory no longer exists: assets");
    await expect(fs.stat(path.join(worktreePath, "assets"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("rejects names and destinations that could escape or modify Git metadata", () => {
    expect(resolveWorkspaceExternalFileCopy("assets", "photo.png")).toEqual({
      directory: "assets",
      fileName: "photo.png",
      destination: "assets/photo.png",
    });
    expect(resolveWorkspaceExternalFileCopy(".", "README.md").destination).toBe("README.md");
    expect(() => resolveWorkspaceExternalFileCopy("../outside", "notes.txt")).toThrow(
      "parent directory traversal is not allowed",
    );
    expect(() => resolveWorkspaceExternalFileCopy("assets", "../notes.txt")).toThrow(
      "path separators are not allowed",
    );
    expect(() => resolveWorkspaceExternalFileCopy("assets", "nested\\notes.txt")).toThrow(
      "path separators are not allowed",
    );
    expect(() => resolveWorkspaceExternalFileCopy(".", ".Git")).toThrow(
      "Git metadata cannot be modified",
    );
    expect(() => resolveWorkspaceExternalFileCopy("assets", "\0secret")).toThrow(
      "control characters are not allowed",
    );
    expect(() => resolveWorkspaceExternalFileCopy("assets", "x".repeat(214))).toThrow(
      "name exceeds 213 bytes",
    );
  });

  test("copies a filename at the maximum staging-safe length", async () => {
    const fileName = "x".repeat(213);
    expect(resolveWorkspaceExternalFileCopy("assets", fileName).fileName).toBe(fileName);
    await expect(
      copyExternalFileToLocalWorkspace(worktreePath, "assets", fileName, "QQ=="),
    ).resolves.toBe(`assets/${fileName}`);
    await expect(fs.readFile(path.join(worktreePath, "assets", fileName), "utf8")).resolves.toBe(
      "A",
    );
  });

  test("the container helper requires an existing directory and preserves collisions", async () => {
    const run = async (
      directory: string,
      name: string,
      contents: Buffer,
      afterReady?: () => Promise<void>,
    ) => {
      const readyToken = afterReady ? "READY" : "";
      const child = spawn(
        process.execPath,
        [
          "-e",
          CONTAINER_PINNED_ATTACHMENT_WRITE,
          worktreePath,
          directory,
          name,
          String(contents.byteLength),
          readyToken,
          "exclusive",
          String(0o644),
          "existing",
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const closed = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        // A refusing helper exits before it reads its input, so the write can
        // land in a closed pipe. As in the product's runCommand, that EPIPE is
        // expected: the exit status and stderr asserted below are the result.
        child.stdin.on("error", (error: NodeJS.ErrnoException) => {
          if (error.code !== "EPIPE") reject(error);
        });
        child.once("close", resolve);
      });
      if (afterReady) {
        child.stdout.once("data", () => {
          void afterReady()
            .then(() => child.stdin.end(contents.toString("base64")))
            .catch((error) => child.stdin.destroy(error));
        });
      } else {
        child.stdin.end(contents.toString("base64"));
      }
      const code = await closed;
      return { code, stderr };
    };

    const contents = Buffer.from([0, 10, 255]);
    const copied = await run("assets", "image.bin", contents);
    expect(copied.code).toBe(0);
    await expect(fs.readFile(path.join(worktreePath, "assets", "image.bin"))).resolves.toEqual(
      contents,
    );

    const collision = await run("assets", "image.bin", Buffer.from("replacement"));
    expect(collision.code).toBe(76);
    expect(collision.stderr).toContain("EEXIST");
    await expect(fs.readFile(path.join(worktreePath, "assets", "image.bin"))).resolves.toEqual(
      contents,
    );

    const missing = await run("missing", "image.bin", contents);
    expect(missing.code).toBe(77);
    expect(missing.stderr).toContain("ENOENT_ANCESTOR");
    await expect(fs.stat(path.join(worktreePath, "missing"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const renamedDirectory = path.join(worktreePath, "assets-renamed");
    const renamed = await run("assets", "late.bin", contents, async () => {
      await fs.rename(path.join(worktreePath, "assets"), renamedDirectory);
    });
    expect(renamed.code).toBe(76);
    expect(renamed.stderr).toContain("ESTALE_DIRECTORY");
    await expect(fs.stat(path.join(renamedDirectory, "late.bin"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
