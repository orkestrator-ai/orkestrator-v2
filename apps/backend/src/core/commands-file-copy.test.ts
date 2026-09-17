import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CONTAINER_PINNED_ATTACHMENT_WRITE,
  copyExternalFileToLocalWorkspace,
  resolveWorkspaceExternalFileCopy,
} from "./commands-files.js";
import { createCommandRegistry, type CommandContext } from "./commands.js";

describe("external workspace file copies", () => {
  let worktreePath = "";

  beforeEach(async () => {
    worktreePath = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-file-copy-"));
    await fs.mkdir(path.join(worktreePath, "assets"));
  });

  afterEach(async () => {
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
    expect(() => resolveWorkspaceExternalFileCopy("assets", "🙂".repeat(64))).toThrow(
      "name exceeds 255 bytes",
    );
  });

  test("the container helper requires an existing directory and preserves collisions", async () => {
    const run = async (directory: string, name: string, contents: Buffer) => {
      const child = spawn(
        process.execPath,
        [
          "-e",
          CONTAINER_PINNED_ATTACHMENT_WRITE,
          worktreePath,
          directory,
          name,
          String(contents.byteLength),
          "",
          "exclusive",
          String(0o644),
          "existing",
        ],
        { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      );
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.stdin.end(contents.toString("base64"));
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
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
  });
});
