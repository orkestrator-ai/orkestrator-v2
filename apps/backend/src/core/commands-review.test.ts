import { afterEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { REVIEW_PACKAGE_FORMAT, type ReviewPackage } from "@orkestrator/protocol/review-workflow";
import {
  generateLoopedReviewPackage,
  parseReviewArtifactStatOutput,
  waitForContainerReviewPackageWrite,
  writeEnvironmentReviewPackage,
} from "./commands-review.js";
import { StorageService } from "./storage.js";

const temporaryDirectories: string[] = [];

function packageFixture(): ReviewPackage {
  return {
    format: REVIEW_PACKAGE_FORMAT,
    id: "package-1",
    round: 1,
    preparedAt: "2026-08-31T00:00:00.000Z",
    targetBranch: "main",
    baseRef: "0".repeat(40),
    headRef: "1".repeat(40),
    commit: null,
    diffCommand: `git diff ${"0".repeat(40)}...${"1".repeat(40)}`,
    changedFiles: [],
    validation: [],
    uncommittedFiles: [],
    limitations: [],
  };
}

type FakeChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof mock>;
};

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = mock(() => true);
  return child;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const exitCode = await process.exited;
  if (exitCode !== 0) {
    throw new Error(await new Response(process.stderr).text());
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

/** A local environment whose worktree holds one commit on `origin/main`. */
async function reviewEnvironment(): Promise<{ worktree: string; storage: StorageService }> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-review-package-"));
  temporaryDirectories.push(root);
  const worktree = path.join(root, "worktree");
  await fs.mkdir(worktree);
  await git(worktree, "init", "--initial-branch=main");
  await git(worktree, "config", "user.email", "test@example.com");
  await git(worktree, "config", "user.name", "Test User");
  await fs.writeFile(path.join(worktree, "tracked.txt"), "committed\n");
  await git(worktree, "add", "tracked.txt");
  await git(worktree, "commit", "-m", "feat: base");
  await git(worktree, "update-ref", "refs/remotes/origin/main", "HEAD");

  const storage = new StorageService(path.join(root, "data"));
  await storage.init();
  await storage.addEnvironment({
    id: "env-1",
    projectId: "project-1",
    name: "review",
    branch: "main",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "full",
    order: 0,
    environmentType: "local",
    worktreePath: worktree,
    setupScriptsComplete: true,
  });
  return { worktree, storage };
}

const ARTIFACT_DIRECTORY = ".orkestrator/review-artifacts/package-1";

async function writeValidationArtifacts(
  worktree: string,
  stdout: string,
  stderr: string,
): Promise<void> {
  await fs.mkdir(path.join(worktree, ARTIFACT_DIRECTORY), { recursive: true });
  await fs.writeFile(path.join(worktree, ARTIFACT_DIRECTORY, "validation-01.stdout.txt"), stdout);
  await fs.writeFile(path.join(worktree, ARTIFACT_DIRECTORY, "validation-01.stderr.txt"), stderr);
}

function validationEntry(overrides: Record<string, unknown> = {}) {
  return {
    command: "bun test",
    status: "passed" as const,
    exitCode: 0,
    stdoutPath: `${ARTIFACT_DIRECTORY}/validation-01.stdout.txt`,
    stderrPath: `${ARTIFACT_DIRECTORY}/validation-01.stderr.txt`,
    durationMs: 1_500,
    limitation: null,
    ...overrides,
  };
}

describe("generateLoopedReviewPackage", () => {
  test("fails closed when tracked or untracked changes remain outside the package", async () => {
    const { worktree, storage } = await reviewEnvironment();
    await fs.writeFile(path.join(worktree, "tracked.txt"), "modified\n");
    await fs.writeFile(path.join(worktree, "untracked.txt"), "new\n");

    await expect(
      generateLoopedReviewPackage(
        "env-1",
        "package-1",
        1,
        "main",
        [],
        [
          { path: "tracked.txt", reason: "Left behind." },
          { path: "untracked.txt", reason: "Left behind." },
        ],
        ["The worktree is not clean."],
        { storage } as never,
      ),
    ).rejects.toThrow("requires a clean worktree");
  });

  test("pins the range and points at validation artifacts without reading file bytes", async () => {
    const { worktree, storage } = await reviewEnvironment();
    await fs.writeFile(path.join(worktree, "tracked.txt"), "modified\n");
    await fs.writeFile(path.join(worktree, "added.ts"), "export const value = 1;\n");
    await git(worktree, "add", "tracked.txt", "added.ts");
    await git(worktree, "commit", "-m", "feat: change");
    await writeValidationArtifacts(worktree, "1 pass\n", "");

    const reference = await generateLoopedReviewPackage(
      "env-1",
      "package-1",
      1,
      "main",
      [validationEntry()],
      [],
      [],
      { storage } as never,
    );

    expect(reference.changedFileCount).toBe(2);
    expect(reference).not.toHaveProperty("diffCharacters");

    const written = JSON.parse(
      await fs.readFile(path.join(worktree, reference.filePath), "utf8"),
    ) as ReviewPackage;
    expect(written.format).toBe(REVIEW_PACKAGE_FORMAT);
    expect(written.baseRef).toMatch(/^[a-f0-9]{40}$/);
    expect(written.headRef).toMatch(/^[a-f0-9]{40}$/);
    expect(written.baseRef).not.toBe(written.headRef);
    expect(written.diffCommand).toContain(`${written.baseRef}...${written.headRef}`);
    expect(written.commit).toEqual({ sha: written.headRef, subject: "feat: change" });
    expect(written.changedFiles).toEqual([
      { path: "added.ts", status: "A" },
      { path: "tracked.txt", status: "M" },
    ]);
    expect(written.validation[0]).toMatchObject({
      command: "bun test",
      status: "passed",
      exitCode: 0,
      stdoutPath: `${ARTIFACT_DIRECTORY}/validation-01.stdout.txt`,
      stderrPath: `${ARTIFACT_DIRECTORY}/validation-01.stderr.txt`,
      stdoutBytes: "1 pass\n".length,
      stderrBytes: 0,
      durationMs: 1_500,
    });

    // The point of the change: no diff text and no file contents travel in the
    // package, so its size no longer tracks the size of the change.
    const serialized = JSON.stringify(written);
    expect(serialized).not.toContain("export const value");
    expect(serialized).not.toContain("diff --git");
  });

  test("records a skipped command without pointing at artifacts it never wrote", async () => {
    const { worktree, storage } = await reviewEnvironment();
    await fs.writeFile(path.join(worktree, "tracked.txt"), "modified\n");
    await git(worktree, "commit", "-am", "feat: change");

    const reference = await generateLoopedReviewPackage(
      "env-1",
      "package-1",
      1,
      "main",
      [
        validationEntry({
          status: "skipped",
          exitCode: null,
          stdoutPath: null,
          stderrPath: null,
          limitation: "No browser runner in this environment.",
        }),
      ],
      [],
      [],
      { storage } as never,
    );

    const written = JSON.parse(
      await fs.readFile(path.join(worktree, reference.filePath), "utf8"),
    ) as ReviewPackage;
    expect(written.validation[0]).toMatchObject({
      status: "skipped",
      stdoutPath: null,
      stderrPath: null,
      stdoutBytes: 0,
      stderrBytes: 0,
      limitation: "No browser runner in this environment.",
    });
  });

  test("refuses to publish a package whose validation artifact is missing", async () => {
    const { worktree, storage } = await reviewEnvironment();
    await fs.writeFile(path.join(worktree, "tracked.txt"), "modified\n");
    await git(worktree, "commit", "-am", "feat: change");
    await fs.mkdir(path.join(worktree, ARTIFACT_DIRECTORY), { recursive: true });
    await fs.writeFile(
      path.join(worktree, ARTIFACT_DIRECTORY, "validation-01.stdout.txt"),
      "1 pass\n",
    );

    await expect(
      generateLoopedReviewPackage("env-1", "package-1", 1, "main", [validationEntry()], [], [], {
        storage,
      } as never),
    ).rejects.toThrow("was not written by preparation");
  });

  test("refuses a validation artifact that resolves outside the workspace", async () => {
    const { worktree, storage } = await reviewEnvironment();
    await fs.writeFile(path.join(worktree, "tracked.txt"), "modified\n");
    await git(worktree, "commit", "-am", "feat: change");
    const outside = path.join(worktree, "..", "outside.txt");
    await fs.writeFile(outside, "secret\n");
    await fs.mkdir(path.join(worktree, ARTIFACT_DIRECTORY), { recursive: true });
    await fs.writeFile(
      path.join(worktree, ARTIFACT_DIRECTORY, "validation-01.stdout.txt"),
      "1 pass\n",
    );
    await fs.symlink(outside, path.join(worktree, ARTIFACT_DIRECTORY, "validation-01.stderr.txt"));

    await expect(
      generateLoopedReviewPackage("env-1", "package-1", 1, "main", [validationEntry()], [], [], {
        storage,
      } as never),
    ).rejects.toThrow("escapes the environment worktree");
  });
});

describe("parseReviewArtifactStatOutput", () => {
  const stdoutPath = `${ARTIFACT_DIRECTORY}/validation-01.stdout.txt`;

  test("reads sizes for every reported artifact", () => {
    const sizes = parseReviewArtifactStatOutput(
      `file\t/workspace/${stdoutPath}\t42\t${stdoutPath}\n`,
      [stdoutPath],
    );
    expect(sizes.get(stdoutPath)).toBe(42);
  });

  test("rejects missing, unreported, and escaping artifacts", () => {
    expect(() =>
      parseReviewArtifactStatOutput(`missing\t\t\t${stdoutPath}\n`, [stdoutPath]),
    ).toThrow("was not written by preparation");
    expect(() => parseReviewArtifactStatOutput("", [stdoutPath])).toThrow(
      "was not written by preparation",
    );
    // Outside the workspace and inside-but-symlinked are different mistakes and
    // a retrying agent fixes them differently.
    expect(() =>
      parseReviewArtifactStatOutput(`file\t/etc/passwd\t42\t${stdoutPath}\n`, [stdoutPath]),
    ).toThrow("escapes the environment worktree");
    expect(() =>
      parseReviewArtifactStatOutput(`file\t/workspace/elsewhere.txt\t42\t${stdoutPath}\n`, [
        stdoutPath,
      ]),
    ).toThrow("must not traverse symbolic links");
    expect(() =>
      parseReviewArtifactStatOutput(`file\t/workspace/${stdoutPath}\tnope\t${stdoutPath}\n`, [
        stdoutPath,
      ]),
    ).toThrow("size could not be read");
  });
});

describe("container review package publication", () => {
  test("wires docker publication, captures helper stderr, and settles on close", async () => {
    const child = fakeChild();
    let stdin = "";
    child.stdin.on("data", (chunk: Buffer) => (stdin += chunk.toString()));
    child.stdin.once("finish", () => queueMicrotask(() => child.emit("close", 0)));
    const spawned: unknown[][] = [];
    const runnerCalls: Array<{ command: string; args: string[] }> = [];
    const reference = await writeEnvironmentReviewPackage(
      {
        id: "env-1",
        environmentType: "container",
        containerId: "container-1",
      } as never,
      async (command, args) => {
        runnerCalls.push({ command, args });
        return "";
      },
      packageFixture(),
      {
        spawn: ((...args: unknown[]) => {
          spawned.push(args);
          return child;
        }) as never,
        timeoutMs: 1_000,
      },
    );

    expect(spawned[0]?.[0]).toBe("docker");
    expect(spawned[0]?.[1]).toEqual(
      expect.arrayContaining(["exec", "-i", "container-1", "overwrite"]),
    );
    expect(Buffer.from(stdin, "base64").byteLength).toBe(reference.bytes);
    expect(runnerCalls.some((call) => call.command === "git")).toBe(true);
    expect(runnerCalls.some((call) => call.command === "chmod")).toBe(false);

    const failed = fakeChild();
    const failure = waitForContainerReviewPackageWrite(failed as never, Buffer.from("x"), 1_000);
    failed.stderr.write("ENOSPC");
    failed.emit("close", 76);
    await expect(failure).rejects.toThrow("ENOSPC");
  });

  test("times out a wedged helper and refuses publication when Git exclusion fails", async () => {
    const child = fakeChild();
    await expect(
      waitForContainerReviewPackageWrite(child as never, Buffer.from("x"), 5),
    ).rejects.toThrow("timed out");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    const spawn = mock(() => fakeChild());
    await expect(
      writeEnvironmentReviewPackage(
        {
          id: "env-1",
          environmentType: "container",
          containerId: "container-1",
        } as never,
        async (command) => {
          if (command === "git") throw new Error("not ignored");
          return "";
        },
        packageFixture(),
        { spawn: spawn as never },
      ),
    ).rejects.toThrow("not Git-excluded");
    expect(spawn).not.toHaveBeenCalled();
  });
});
