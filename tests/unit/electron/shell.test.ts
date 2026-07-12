import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { APP_SLUG } from "../../../apps/backend/src/core/constants";
import {
  commandExists,
  homePath,
  inferLanguage,
  pathExists,
  readFileBase64,
  readTextFile,
  runCommand,
  writeFileBase64,
} from "../../../apps/backend/src/core/shell";

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

describe("runCommand", () => {
  test("captures stdout from a successful command", async () => {
    const { stdout, stderr } = await runCommand("node", ["-e", "process.stdout.write('hi')"]);
    expect(stdout).toBe("hi");
    expect(stderr).toBe("");
  });

  test("captures stderr from a successful command", async () => {
    const { stdout, stderr } = await runCommand("node", ["-e", "process.stderr.write('warn')"]);
    expect(stdout).toBe("");
    expect(stderr).toBe("warn");
  });

  test("returns quickly when a child reads piped stdin instead of hanging until timeout", async () => {
    // The child reads all of stdin to completion. Because runCommand closes the
    // child's stdin pipe immediately, the child receives EOF and exits rather
    // than blocking. A regression that removed `stdin.end()` would hang here
    // until the timeout fires and the assertion would fail.
    const { stdout } = await runCommand(
      "node",
      [
        "-e",
        "let data = '';process.stdin.on('data', (c) => { data += c; });process.stdin.on('end', () => { process.stdout.write('eof:' + data.length); });",
      ],
      { timeoutMs: 5_000 },
    );
    expect(stdout).toBe("eof:0");
  });

  test("throws with stderr text when the command exits non-zero", async () => {
    await expect(
      runCommand("node", ["-e", "process.stderr.write('boom');process.exit(1)"]),
    ).rejects.toThrow("boom");
  });

  test("rejects when the command does not exist", async () => {
    await expect(runCommand("orkestrator-no-such-binary-xyz", [])).rejects.toThrow();
  });
});

describe("commandExists", () => {
  test("resolves true for a binary on PATH", async () => {
    expect(await commandExists("node")).toBe(true);
  });

  test("resolves false for a missing binary", async () => {
    expect(await commandExists("orkestrator-no-such-binary-xyz")).toBe(false);
  });
});

describe("pathExists", () => {
  test("resolves true for an existing path and false for a missing one", async () => {
    const dir = await createTempDir("ork-path-exists-");
    const file = path.join(dir, "present.txt");
    await fs.writeFile(file, "x");
    expect(await pathExists(file)).toBe(true);
    expect(await pathExists(path.join(dir, "missing.txt"))).toBe(false);
  });
});

describe("homePath", () => {
  test("joins segments onto the home directory", () => {
    expect(homePath("a", "b")).toBe(path.join(os.homedir(), "a", "b"));
    expect(homePath()).toBe(os.homedir());
  });
});

describe("inferLanguage", () => {
  test("maps known extensions to language aliases", () => {
    expect(inferLanguage("a/b/file.ts")).toBe("typescript");
    expect(inferLanguage("file.tsx")).toBe("typescript");
    expect(inferLanguage("file.rs")).toBe("rust");
    expect(inferLanguage("file.YML")).toBe("yaml");
  });

  test("falls back to the raw extension for unknown types and empty for none", () => {
    expect(inferLanguage("file.go")).toBe("go");
    expect(inferLanguage("Makefile")).toBe("");
  });
});
