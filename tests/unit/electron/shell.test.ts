import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { APP_SLUG } from "../../../apps/backend/src/core/constants";
import { MAX_BINARY_FILE_BYTES } from "../../../apps/backend/src/core/path-safety";
import {
  CommandFailedError,
  commandExists,
  homePath,
  inferLanguage,
  pathExists,
  readFileBase64,
  readTextFile,
  runCommand,
  spawnCommand,
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

async function captureCommandFailure(promise: Promise<unknown>): Promise<CommandFailedError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CommandFailedError);
    return error as CommandFailedError;
  }
  throw new Error("Expected command to fail");
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

    const linkedFile = path.join(allowedDir, "linked.png");
    const chainedFile = path.join(allowedDir, "chained.png");
    await fs.symlink(allowedFile, linkedFile);
    await fs.symlink(linkedFile, chainedFile);
    await expect(readFileBase64(linkedFile)).rejects.toThrow("symbolic links are not allowed");
    await expect(readFileBase64(chainedFile)).rejects.toThrow("symbolic links are not allowed");

    const oversizedFile = path.join(allowedDir, "oversized.png");
    await fs.writeFile(oversizedFile, Buffer.alloc(MAX_BINARY_FILE_BYTES + 1, 1));
    await expect(readFileBase64(oversizedFile)).rejects.toThrow(
      `File exceeds ${MAX_BINARY_FILE_BYTES} bytes`,
    );

    const outsideRoot = await createTempDir("ork-shell-outside-");
    const disallowedFile = path.join(outsideRoot, "Downloads", "image.png");
    await fs.mkdir(path.dirname(disallowedFile), { recursive: true });
    await fs.writeFile(disallowedFile, "outside");
    const linkedDirectory = path.join(allowedDir, "outside-directory");
    await fs.symlink(path.dirname(disallowedFile), linkedDirectory);
    await expect(readFileBase64(path.join(linkedDirectory, "image.png"))).rejects.toThrow(
      "symbolic links are not allowed",
    );

    const directoryTarget = path.join(allowedDir, "folder.png");
    await fs.mkdir(directoryTarget);
    await expect(readFileBase64(directoryTarget)).rejects.toThrow("not a stable regular file");

    await expect(readFileBase64(disallowedFile)).rejects.toThrow(
      "outside Orkestrator workspace storage",
    );
  });

  test("writes and reads only relative paths inside the requested root", async () => {
    const root = await createTempDir("ork-workspaces-");
    const worktree = path.join(root, "orkestrator-ai", "workspaces", "project");
    await fs.mkdir(worktree, { recursive: true });

    await expect(
      writeFileBase64(worktree, "../escape.txt", Buffer.from("bad").toString("base64")),
    ).rejects.toThrow("parent directory traversal");

    const writtenPath = await writeFileBase64(
      worktree,
      "src\\hello.ts",
      Buffer.from("export {};").toString("base64"),
    );
    expect(writtenPath).toBe(path.join(worktree, "src", "hello.ts"));

    await expect(readTextFile(worktree, "/absolute.ts")).rejects.toThrow("absolute paths");
    await expect(readTextFile(worktree, "src/../hello.ts")).rejects.toThrow(
      "parent directory traversal",
    );
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

  test("writes an explicit stdin payload before closing the pipe", async () => {
    const { stdout } = await runCommand(
      "node",
      [
        "-e",
        "let data = '';process.stdin.on('data', (c) => { data += c; });process.stdin.on('end', () => { process.stdout.write(data); });",
      ],
      { stdin: "credential-from-stdin", timeoutMs: 5_000 },
    );
    expect(stdout).toBe("credential-from-stdin");
  });

  test("preserves binary stdin payloads including NUL bytes", async () => {
    const payload = Buffer.from([0x00, 0xff, 0x41, 0x00]);
    const { stdout } = await runCommand(
      "node",
      [
        "-e",
        "const chunks=[];process.stdin.on('data',(chunk)=>chunks.push(chunk));process.stdin.on('end',()=>process.stdout.write(Buffer.concat(chunks).toString('hex')));",
      ],
      { stdin: payload, timeoutMs: 5_000 },
    );

    expect(stdout).toBe(payload.toString("hex"));
  });

  test("preserves a numeric non-zero exit as structured failure metadata", async () => {
    const failure = await captureCommandFailure(
      runCommand("node", ["-e", "process.stderr.write('boom');process.exit(23)"]),
    );

    expect(failure.message).toBe("boom");
    expect(failure.timedOut).toBe(false);
    expect(failure.executableMissing).toBe(false);
    expect(failure.exitCode).toBe(23);
    expect(failure.signal).toBeNull();
  });

  test("preserves timeout and termination signal as structured failure metadata", async () => {
    const failure = await captureCommandFailure(
      runCommand("node", ["-e", "setInterval(() => {}, 1_000)"], { timeoutMs: 20 }),
    );

    expect(failure.timedOut).toBe(true);
    expect(failure.executableMissing).toBe(false);
    expect(failure.exitCode).toBeNull();
    expect(failure.signal).toBe("SIGTERM");
  });

  test("redacts sensitive values from successful output and command failures", async () => {
    const secret = "github_secret_token";
    const success = await runCommand(
      "node",
      [
        "-e",
        "process.stdout.write(process.env.TEST_SECRET);process.stderr.write(process.env.TEST_SECRET)",
      ],
      {
        env: { ...process.env, TEST_SECRET: secret },
        redactValues: [secret],
      },
    );
    expect(success).toEqual({
      stdout: "[REDACTED]",
      stderr: "[REDACTED]",
    });

    let failure: unknown;
    try {
      await runCommand(
        "node",
        [
          "-e",
          "process.stderr.write('Docker permission denied for ' + process.env.TEST_SECRET);process.exit(1)",
        ],
        {
          env: { ...process.env, TEST_SECRET: secret },
          redactValues: [secret],
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(CommandFailedError);
    expect((failure as CommandFailedError).message).toBe("Docker permission denied for [REDACTED]");
    expect((failure as CommandFailedError).message).not.toContain(secret);
    expect((failure as CommandFailedError).timedOut).toBe(false);
    expect((failure as CommandFailedError).executableMissing).toBe(false);
    expect((failure as CommandFailedError).exitCode).toBe(1);
    expect((failure as CommandFailedError).signal).toBeNull();

    let argvFailure: unknown;
    try {
      await runCommand("node", ["-e", "process.exit(1)", secret], { redactValues: [secret] });
    } catch (error) {
      argvFailure = error;
    }

    expect(argvFailure).toBeInstanceOf(CommandFailedError);
    expect((argvFailure as CommandFailedError).message).toContain("[REDACTED]");
    expect((argvFailure as CommandFailedError).message).not.toContain(secret);
    expect((argvFailure as CommandFailedError).timedOut).toBe(false);
    expect((argvFailure as CommandFailedError).executableMissing).toBe(false);
    expect((argvFailure as CommandFailedError).exitCode).toBe(1);
    expect((argvFailure as CommandFailedError).signal).toBeNull();
  });

  test("preserves a missing executable as structured failure metadata", async () => {
    const failure = await captureCommandFailure(runCommand("orkestrator-no-such-binary-xyz", []));

    expect(failure.timedOut).toBe(false);
    expect(failure.executableMissing).toBe(true);
    expect(failure.exitCode).toBeNull();
    expect(failure.signal).toBeNull();
  });

  test("can launch a child in an owned process group", async () => {
    const child = spawnCommand(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
      detached: true,
    });
    expect(child.pid).toBeGreaterThan(0);
    try {
      process.kill(-(child.pid ?? 0), "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(child.signalCode).toBe("SIGTERM");
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
