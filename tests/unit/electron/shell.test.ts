import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { APP_SLUG } from "../../../electron/backend/constants";
import { readFileBase64, readTextFile, writeFileBase64 } from "../../../electron/backend/shell";

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function createWorkspaceTempDir(prefix: string): Promise<string> {
  const workspacesRoot = path.join(os.homedir(), APP_SLUG, "workspaces");
  await fs.mkdir(workspacesRoot, { recursive: true });
  const dir = await fs.mkdtemp(path.join(workspacesRoot, prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("Electron shell file helpers", () => {
  test("reads base64 only from Orkestrator-managed host paths", async () => {
    const root = await createWorkspaceTempDir("ork-shell-");
    const allowedDir = path.join(root, ".orkestrator", "clipboard");
    const allowedFile = path.join(allowedDir, "image.png");
    await fs.mkdir(allowedDir, { recursive: true });
    await fs.writeFile(allowedFile, Buffer.from("image-bytes"));

    expect(await readFileBase64(allowedFile)).toBe(Buffer.from("image-bytes").toString("base64"));

    const outsideRoot = await createTempDir("ork-shell-outside-");
    const disallowedFile = path.join(outsideRoot, "Downloads", "image.png");
    await fs.mkdir(path.dirname(disallowedFile), { recursive: true });
    await fs.writeFile(disallowedFile, "outside");
    await expect(readFileBase64(disallowedFile)).rejects.toThrow("outside Orkestrator workspace storage");
  });

  test("writes and reads only relative paths inside the requested root", async () => {
    const root = await createTempDir("ork-workspaces-");
    const worktree = path.join(root, "orkestrator-ai", "workspaces", "project");
    await fs.mkdir(worktree, { recursive: true });

    await expect(writeFileBase64(worktree, "../escape.txt", Buffer.from("bad").toString("base64"))).rejects.toThrow(
      "parent directory traversal",
    );

    const writtenPath = await writeFileBase64(worktree, "src\\hello.ts", Buffer.from("export {};").toString("base64"));
    expect(writtenPath).toBe(path.join(worktree, "src", "hello.ts"));

    await expect(readTextFile(worktree, "/absolute.ts")).rejects.toThrow("absolute paths");
    await expect(readTextFile(worktree, "src/../hello.ts")).rejects.toThrow("parent directory traversal");
    await expect(readTextFile(worktree, "src/hello.ts")).resolves.toEqual({
      path: "src/hello.ts",
      content: "export {};",
      language: "typescript",
    });
  });
});
