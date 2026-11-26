import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  reviewDiffArtifactPath,
  reviewDiffChunkArtifactPath,
} from "@orkestrator/protocol/review-artifacts";
import { isReviewPackage, type ReviewPackage } from "@orkestrator/protocol/review-workflow";
import { BackendRuntime } from "../backend-runtime.js";
import {
  generateReviewPackage,
  verifyEnvironmentReviewPackage,
  readEnvironmentWorkspaceFile,
  writeEnvironmentReviewArtifact,
} from "../commands/review.js";
import {
  REVIEW_DIFF_CHUNK_THRESHOLD_BYTES,
  reviewDiffArgs,
  reviewDiffHeaderPath,
  sealReviewDiff,
  splitReviewDiff,
  verifyReviewDiffArtifact,
} from "./diff-artifact.js";
import { CommandFailedError } from "../shell.js";
import { StorageService } from "../storage/service.js";

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
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "a...b",
    ]);
  });
});

function fileDiff(file: string, lines: number, width = 40): string {
  return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -0,0 +1,${lines} @@\n${Array.from({ length: lines }, (_, i) => `+${String(i).padEnd(width, "x")}\n`).join("")}`;
}

describe("splitReviewDiff", () => {
  test("cuts only between file diffs, and the parts concatenate to the diff", () => {
    const diff = ["a.ts", "dir with space/b.ts", "c.ts", "d.ts"]
      .map((file) => fileDiff(file, 20))
      .join("");
    const parts = splitReviewDiff(diff, 1_500);
    expect(parts.length).toBeGreaterThan(1);
    expect(Buffer.concat(parts.map((part) => part.contents)).toString("utf8")).toBe(diff);
    for (const part of parts) expect(part.contents.toString("utf8")).toStartWith("diff --git ");
    expect(parts.flatMap((part) => part.files)).toEqual([
      "a.ts",
      "dir with space/b.ts",
      "c.ts",
      "d.ts",
    ]);
  });

  test("splits one oversized file diff and never makes more than 64 parts", () => {
    const diff = `${fileDiff("big.ts", 400)}${fileDiff("small.ts", 2)}`;
    const parts = splitReviewDiff(diff, 100);
    expect(parts.filter((part) => part.files.includes("big.ts")).length).toBeGreaterThan(1);
    expect(Buffer.concat(parts.map((part) => part.contents)).toString("utf8")).toBe(diff);
    const many = Array.from({ length: 200 }, (_, i) => fileDiff(`f${i}.ts`, 1)).join("");
    const bounded = splitReviewDiff(many, 1);
    expect(bounded.length).toBeLessThanOrEqual(64);
    expect(Buffer.concat(bounded.map((part) => part.contents)).toString("utf8")).toBe(many);
  });

  test("reads quoted and unquoted headers", () => {
    expect(reviewDiffHeaderPath("diff --git a/x y.ts b/x y.ts")).toBe("x y.ts");
    expect(reviewDiffHeaderPath('diff --git "a/tab\\there" "b/tab\\there"')).toBe("tab\there");
    expect(reviewDiffHeaderPath("diff --git a/x b/y")).toBeUndefined();
  });
});

describe("sealReviewDiff parts", () => {
  test("seals a large diff's parts beside it, each under its digest", async () => {
    const diff = ["a.ts", "b.ts", "c.ts"].map((file) => fileDiff(file, 30)).join("");
    const writes = new Map<string, Buffer>();
    const sealed = await sealReviewDiff({
      packageId: "p",
      diff: async () => diff,
      write: async (filePath, contents) => {
        writes.set(filePath, contents);
      },
      chunkThresholdBytes: 100,
      chunkTargetBytes: 1_500,
    });
    expect(sealed.limitation).toBeUndefined();
    const chunks = sealed.chunks!;
    expect(chunks.map((chunk) => chunk.index)).toEqual([1, 2, 3]);
    for (const chunk of chunks) {
      const contents = writes.get(chunk.path)!;
      expect(chunk).toEqual({
        index: chunk.index,
        path: reviewDiffChunkArtifactPath("p", chunk.index, sha(contents)),
        bytes: contents.byteLength,
        sha256: sha(contents),
        files: [["a.ts", "b.ts", "c.ts"][chunk.index - 1]!],
      });
    }
  });

  test("only the diff under the threshold has no parts", async () => {
    const small = await sealReviewDiff({
      packageId: "p",
      diff: async () => fileDiff("a.ts", 3),
      write: async () => {},
    });
    expect(small.chunks).toBeUndefined();
    const single = await sealReviewDiff({
      packageId: "p",
      diff: async () => fileDiff("a.ts", 300),
      write: async () => {},
      chunkThresholdBytes: 10,
      chunkTargetBytes: 10,
    });
    expect(single.chunks!.length).toBeGreaterThan(1);
    expect(single.chunks!.every((chunk) => chunk.files.includes("a.ts"))).toBe(true);
  });

  test("a part that cannot be written keeps the whole diff and says why", async () => {
    const sealed = await sealReviewDiff({
      packageId: "p",
      diff: async () => `${fileDiff("a.ts", 30)}${fileDiff("b.ts", 30)}`,
      write: async (filePath) => {
        if (filePath.includes("review-diff-part-")) throw new Error("disk full");
      },
      chunkThresholdBytes: 100,
      chunkTargetBytes: 100,
    });
    expect(sealed.artifact).toBeDefined();
    expect(sealed.chunks).toBeUndefined();
    expect(sealed.limitation).toContain("could not be split into parts");
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
      `git diff --no-color --no-ext-diff --no-textconv --no-renames --src-prefix=a/ --dst-prefix=b/ ${written.baseRef}...${written.headRef}`,
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

test("a very large diff is sealed in parts the package names and verification checks", async () => {
  const { worktree, context } = await reviewedEnvironment();
  await git(worktree, "config", "diff.noprefix", "true");
  await git(worktree, "config", "core.quotePath", "true");
  const name = "α large.ts";
  const lines = Array.from({ length: 20_000 }, (_, i) => `export const line${i} = ${i};`);
  await fs.writeFile(path.join(worktree, name), `${lines.join("\n")}\n`);
  await git(worktree, "add", "--", name);
  await git(worktree, "commit", "-m", "feat: large change");
  const reference = await generateReviewPackage("env-1", "large", 1, "main", [], [], [], context);
  const written = JSON.parse(
    await fs.readFile(path.join(worktree, reference.filePath), "utf8"),
  ) as ReviewPackage;

  expect(isReviewPackage(written, 1)).toBe(true);
  expect(written.diffArtifact!.bytes).toBeGreaterThan(REVIEW_DIFF_CHUNK_THRESHOLD_BYTES);
  const chunks = written.diffChunks!;
  expect(chunks.length).toBeGreaterThan(1);
  const parts = await Promise.all(
    chunks.map((chunk) => fs.readFile(path.join(worktree, chunk.path))),
  );
  const whole = await fs.readFile(path.join(worktree, written.diffArtifact!.path));
  expect(Buffer.concat(parts).equals(whole)).toBe(true);
  expect(reference.diffChunkCount).toBe(chunks.length);
  expect(chunks.filter((chunk) => chunk.files.includes(name)).length).toBeGreaterThan(1);
  expect(Math.max(...chunks.map((chunk) => chunk.bytes))).toBeLessThanOrEqual(256 * 1024);
  expect(Array.from(new Set(chunks.flatMap((chunk) => chunk.files))).sort()).toEqual(
    ["added.ts", "tracked.txt", name].sort(),
  );
  expect(await git(worktree, "status", "--porcelain")).toBe("");
  expect(await verifyEnvironmentReviewPackage("env-1", reference, context)).toMatchObject({
    valid: true,
  });

  const file = path.join(worktree, chunks[1]!.path);
  await fs.chmod(file, 0o644);
  await fs.appendFile(file, "+an injected line\n");
  const verification = await verifyEnvironmentReviewPackage("env-1", reference, context);
  expect(verification.valid).toBe(false);
  expect(verification.reason).toContain("Review diff byte count changed");
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
