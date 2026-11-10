import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewDiffArtifactPath } from "@orkestrator/protocol/review-artifacts";
import { isReviewPackage, type ReviewPackage } from "@orkestrator/protocol/review-workflow";
import { BackendRuntime } from "./backend-runtime.js";
import {
  generateReviewPackage,
  verifyEnvironmentReviewPackage,
  readEnvironmentWorkspaceFile,
  writeEnvironmentReviewArtifact,
} from "./commands-review.js";
import {
  reviewDiffArgs,
  sealReviewDiff,
  verifyReviewDiffArtifact,
} from "./review-diff-artifact.js";
import { CommandFailedError } from "./shell.js";
import { StorageService } from "./storage.js";

// Real Git runs under aggregate load; Bun's 5 s default is too tight for it.
setDefaultTimeout(30_000);

const temporaryDirectories: string[] = [];
const runtimes: BackendRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.shutdown();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

const sha = (contents: string | Buffer) => createHash("sha256").update(contents).digest("hex");

describe("sealReviewDiff", () => {
  test("writes the diff under its digest and describes it", async () => {
    const writes: Array<[string, string]> = [];
    const sealed = await sealReviewDiff({
      packageId: "package-1",
      diff: async () => "diff --git a/x b/x\n+é\n",
      write: async (filePath, contents) => {
        writes.push([filePath, contents.toString("utf8")]);
      },
    });
    const bytes = Buffer.byteLength("diff --git a/x b/x\n+é\n");
    const digest = sha("diff --git a/x b/x\n+é\n");
    expect(sealed).toEqual({
      artifact: { path: reviewDiffArtifactPath("package-1", digest), bytes, sha256: digest },
    });
    expect(writes).toEqual([
      [reviewDiffArtifactPath("package-1", digest), "diff --git a/x b/x\n+é\n"],
    ]);
  });

  test("seals an empty diff: an empty range is still the reviewed range", async () => {
    const sealed = await sealReviewDiff({
      packageId: "package-1",
      diff: async () => "",
      write: async () => {},
    });
    expect(sealed.artifact).toMatchObject({ bytes: 0, sha256: sha("") });
  });

  test("leaves a too-large, unproducible or unwritable diff out with a limitation", async () => {
    let wrote = false;
    const write = async () => {
      wrote = true;
    };
    const tooLarge = await sealReviewDiff({
      packageId: "p",
      diff: async () => "x".repeat(11),
      write,
      maxBytes: 10,
    });
    expect(tooLarge.artifact).toBeUndefined();
    expect(tooLarge.limitation).toContain("was not saved as a file");
    expect(wrote).toBe(false);

    const overflow = await sealReviewDiff({
      packageId: "p",
      diff: async () => {
        throw new CommandFailedError("too much", { outputLimitExceeded: true });
      },
      write,
    });
    expect(overflow.limitation).toContain("larger than 16 MiB");

    const failed = await sealReviewDiff({
      packageId: "p",
      diff: async () => {
        throw new Error("git failed");
      },
      write,
    });
    expect(failed.limitation).toContain("could not be produced");

    const unwritable = await sealReviewDiff({
      packageId: "p",
      diff: async () => "diff",
      write: async () => {
        throw new Error("read-only file system");
      },
    });
    expect(unwritable.limitation).toContain("could not be saved");
    for (const result of [tooLarge, overflow, failed, unwritable]) {
      expect(result.limitation).toContain("refuses Git commands cannot read the diff");
      // A limitation says what happened, never the environment's error text.
      expect(result.limitation).not.toContain("read-only file system");
    }
  });

  test("never runs an external diff or textconv helper", () => {
    expect(reviewDiffArgs("a...b")).toEqual([
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "a...b",
    ]);
  });
});

describe("verifyReviewDiffArtifact", () => {
  const artifact = { path: "d.patch", bytes: 4, sha256: sha("diff") };

  test("accepts the sealed bytes and names every other outcome", async () => {
    expect(
      await verifyReviewDiffArtifact(artifact, async () => Buffer.from("diff")),
    ).toBeUndefined();
    expect(await verifyReviewDiffArtifact(artifact, async () => Buffer.from("diffs"))).toContain(
      "byte count changed",
    );
    expect(await verifyReviewDiffArtifact(artifact, async () => Buffer.from("DIFF"))).toBe(
      "Review diff SHA-256 changed",
    );
    expect(
      await verifyReviewDiffArtifact(artifact, async () => {
        throw new Error("Review artifact could not be read");
      }),
    ).toBe("Review artifact could not be read");
  });
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  if (exitCode !== 0) throw new Error(await new Response(child.stderr).text());
  return stdout;
}

/** A local environment with one reviewed commit on top of `origin/main`. */
async function reviewedEnvironment() {
  const root = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-review-diff-"));
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
  await fs.writeFile(path.join(worktree, "tracked.txt"), "changed\n");
  await fs.writeFile(path.join(worktree, "added.ts"), "export const value = 1;\n");
  await git(worktree, "add", "tracked.txt", "added.ts");
  await git(worktree, "commit", "-m", "feat: change");

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
  const runtime = new BackendRuntime({ emit: () => undefined });
  runtimes.push(runtime);
  return { worktree, context: { storage, runtime } as never };
}

describe("review package diff artifact", () => {
  test("the package names a sealed, read-only copy of exactly what diffCommand prints", async () => {
    const { worktree, context } = await reviewedEnvironment();
    const reference = await generateReviewPackage(
      "env-1",
      "package-1",
      1,
      "main",
      [],
      [],
      [],
      context,
    );
    const written = JSON.parse(
      await fs.readFile(path.join(worktree, reference.filePath), "utf8"),
    ) as ReviewPackage;

    expect(isReviewPackage(written, 1)).toBe(true);
    expect(written.diffCommand).toBe(
      `git diff --no-color --no-ext-diff --no-textconv --no-renames ${written.baseRef}...${written.headRef}`,
    );
    const expected = await git(worktree, ...written.diffCommand.split(" ").slice(1));
    expect(expected).toContain("+export const value = 1;");
    const artifact = written.diffArtifact!;
    const onDisk = await fs.readFile(path.join(worktree, artifact.path));
    expect(onDisk.toString("utf8")).toBe(expected);
    expect(artifact).toEqual({
      path: reviewDiffArtifactPath("package-1", sha(onDisk)),
      bytes: onDisk.byteLength,
      sha256: sha(onDisk),
    });
    expect((await fs.stat(path.join(worktree, artifact.path))).mode & 0o777).toBe(0o444);
    // Sealed beside the package: Git-excluded, so it never shows as a change.
    expect(await git(worktree, "status", "--porcelain")).toBe("");
    expect(written.limitations).toEqual([]);

    expect(await verifyEnvironmentReviewPackage("env-1", reference, context)).toMatchObject({
      valid: true,
    });
  });

  test("a changed diff file fails the package check before a reviewer reads it", async () => {
    const { worktree, context } = await reviewedEnvironment();
    const reference = await generateReviewPackage(
      "env-1",
      "package-1",
      1,
      "main",
      [],
      [],
      [],
      context,
    );
    const written = JSON.parse(
      await fs.readFile(path.join(worktree, reference.filePath), "utf8"),
    ) as ReviewPackage;
    const file = path.join(worktree, written.diffArtifact!.path);
    await fs.chmod(file, 0o644);
    await fs.appendFile(file, "+an injected line\n");

    const verification = await verifyEnvironmentReviewPackage("env-1", reference, context);
    expect(verification.valid).toBe(false);
    expect(verification.reason).toContain("Review diff byte count changed");
  });
});

test("non-UTF-8 Git output is omitted with an explicit fidelity limitation", async () => {
  const { worktree, context } = await reviewedEnvironment();
  await fs.writeFile(path.join(worktree, "latin.txt"), Buffer.from([0xe9, 10]));
  await git(worktree, "add", "latin.txt");
  await git(worktree, "commit", "-m", "non UTF-8 fixture");
  const reference = await generateReviewPackage("env-1", "latin", 1, "main", [], [], [], context);
  const written = JSON.parse(
    await fs.readFile(path.join(worktree, reference.filePath), "utf8"),
  ) as ReviewPackage;
  expect(written.diffArtifact).toBeUndefined();
  expect(written.limitations.some((entry) => entry.includes("cannot be sealed faithfully"))).toBe(
    true,
  );
});

test("container artifact verification reads exact decoded bytes and rejects substituted paths", async () => {
  const contents = Buffer.from("diff\n+container\n");
  const artifact = {
    path: reviewDiffArtifactPath("container", sha(contents)),
    bytes: contents.length,
    sha256: sha(contents),
  };
  const environment = { environmentType: "container", containerId: "fixture-only" } as never;
  const calls: string[] = [];
  const runner = async (command: string, args: string[]) => {
    calls.push(command);
    expect(args).toContain(`/workspace/${artifact.path}`);
    return command === "realpath" ? `/workspace/${artifact.path}\n` : contents.toString("base64");
  };
  expect(
    await verifyReviewDiffArtifact(artifact, (file) =>
      readEnvironmentWorkspaceFile(environment, runner, file),
    ),
  ).toBeUndefined();
  expect(calls).toEqual(["realpath", "base64"]);
  await expect(
    readEnvironmentWorkspaceFile(environment, async () => "/elsewhere", artifact.path),
  ).rejects.toThrow("symbolic links");
});

test("container artifact writes preserve bytes, mode and exclusion before publication", async () => {
  const contents = Buffer.from("diff\n+container\n");
  const file = reviewDiffArtifactPath("container", sha(contents));
  const environment = { environmentType: "container", containerId: "fixture-only" } as never;
  const commands: string[] = [];
  let writes = 0;
  const runner = async (command: string) => {
    commands.push(command);
    return "";
  };
  const run = (async (command: string, args: string[], options: { stdin: string }) => {
    writes++;
    expect(command).toBe("docker");
    expect(args.slice(0, 4)).toEqual(["exec", "-i", "fixture-only", "node"]);
    expect(args.slice(-6)).toEqual([
      ".orkestrator/review-artifacts/container",
      path.posix.basename(file),
      String(contents.length),
      "",
      "overwrite",
      String(0o444),
    ]);
    expect(Buffer.from(options.stdin, "base64")).toEqual(contents);
    return { stdout: "", stderr: "" };
  }) as never;
  await writeEnvironmentReviewArtifact(environment, runner, file, contents, { run });
  expect(commands).toEqual(["bash", "git"]);
  expect(writes).toBe(1);
  await expect(
    writeEnvironmentReviewArtifact(
      environment,
      async () => {
        throw new Error("exclusion failed");
      },
      file,
      contents,
      { run },
    ),
  ).rejects.toThrow("exclusion failed");
  expect(writes).toBe(1);
});
