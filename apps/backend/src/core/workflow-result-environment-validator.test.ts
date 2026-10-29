import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EnvironmentGit } from "./build-pipeline-code-rewind.js";
import { runCommand } from "./shell.js";
import { gitEnvironmentValidator } from "./workflow-result-environment-validator.js";
import type { WorkflowResultEnvironmentRequest } from "./workflow-result-registry.js";

/** A real repository behind the environment Git port, as a local worktree runs it. */
describe("git-backed environment validator", () => {
  let root: string;
  let repository: string;
  let outside: string;
  let base: string;
  let head: string;
  let sideCommit: string;
  let calls = 0;
  const git: EnvironmentGit = async (environmentId, args) => {
    calls++;
    const cwd = environmentId === "missing" ? root : repository;
    return (await runCommand("git", args, { cwd, timeoutMs: 30_000 })).stdout;
  };
  const validate = gitEnvironmentValidator(git);

  async function run(...args: string[]): Promise<string> {
    return (await runCommand("git", args, { cwd: repository })).stdout.trim();
  }

  function request(
    validator: WorkflowResultEnvironmentRequest["validator"],
    value: unknown,
    environmentId = "env-1",
  ): WorkflowResultEnvironmentRequest {
    return {
      attempt: { resultKey: "key-1", kind: "graph-output", environmentId, projectId: "project-1" },
      validator,
      value,
    };
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "ork-env-validator-"));
    repository = join(root, "repo");
    outside = join(root, "outside");
    await mkdir(repository);
    await mkdir(outside);
    await writeFile(join(outside, "secret.txt"), "outside");
    await run("init", "-q", "-b", "main");
    await run("config", "user.email", "test@example.com");
    await run("config", "user.name", "Test");
    await writeFile(join(repository, "a.txt"), "a");
    await run("add", "a.txt");
    await run("commit", "-qm", "base");
    base = await run("rev-parse", "HEAD");
    await run("checkout", "-qb", "feature/cache");
    await mkdir(join(repository, "src"));
    await writeFile(join(repository, "src", "cache.ts"), "export {};");
    await symlink(outside, join(repository, "escape"));
    await run("add", "src/cache.ts", "escape");
    await run("commit", "-qm", "cache");
    head = await run("rev-parse", "HEAD");
    await run("checkout", "-qb", "side", base);
    await writeFile(join(repository, "side.txt"), "side");
    await run("add", "side.txt");
    await run("commit", "-qm", "side");
    sideCommit = await run("rev-parse", "HEAD");
    await run("checkout", "-q", "feature/cache");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("a commit on its branch, with an ancestor base, passes", async () => {
    expect(
      await validate(
        request("workspace-commit", { branch: "feature/cache", headRef: head, baseRef: base }),
      ),
    ).toEqual([]);
    expect(
      await validate(
        request("workspace-commit", { branch: "feature/cache", headRef: base, baseRef: null }),
      ),
    ).toEqual([]);
  });

  test("missing commits and branches, unreachable heads and non-ancestor bases are reported", async () => {
    const unknown = "f".repeat(40);
    expect(
      await validate(
        request("workspace-commit", { branch: "feature/none", headRef: unknown, baseRef: unknown }),
      ),
    ).toEqual([
      expect.objectContaining({ path: "$.headRef", code: "unknown_commit" }),
      expect.objectContaining({ path: "$.branch", code: "unknown_branch" }),
      expect.objectContaining({ path: "$.baseRef", code: "unknown_commit" }),
    ]);
    expect(
      await validate(
        request("workspace-commit", {
          branch: "feature/cache",
          headRef: sideCommit,
          baseRef: null,
        }),
      ),
    ).toEqual([expect.objectContaining({ path: "$.headRef", code: "not_reachable" })]);
    expect(
      await validate(
        request("workspace-commit", { branch: "feature/cache", headRef: base, baseRef: head }),
      ),
    ).toEqual([expect.objectContaining({ path: "$.baseRef", code: "not_ancestor" })]);
  });

  test("file paths must resolve inside the worktree; deleted or new paths are fine", async () => {
    const files = [
      { path: "src/cache.ts", reason: "Changed." },
      { path: "src/removed.ts", reason: "Deleted." },
      { path: "escape/secret.txt", reason: "Through a link." },
      { path: ":(top)magic", reason: "Pathspec magic is literal." },
      { path: "escape", reason: "The link itself is inside." },
    ];
    expect(await validate(request("file-list-paths", { files }))).toEqual([
      {
        path: "$.files[2].path",
        code: "outside_worktree",
        message:
          "The path does not resolve inside the environment's worktree (it leads through a symbolic link).",
      },
    ]);
  });

  test("a long list is checked in batches and bad paths are located", async () => {
    const files = Array.from({ length: 600 }, (_, index) => ({
      path:
        index === 17 || index === 450
          ? `escape/f-${index}.txt`
          : `src/f-${index}-${"x".repeat(40)}.ts`,
      reason: "Listed.",
    }));
    calls = 0;
    const issues = await validate(request("file-list-paths", { files }));
    expect(issues.map((issue) => issue.path)).toEqual(["$.files[17].path", "$.files[450].path"]);
    expect(calls).toBeLessThan(40);
  });

  test("a repository that cannot be read throws, so the service fails closed", async () => {
    await expect(
      validate(
        request("workspace-commit", { branch: "main", headRef: head, baseRef: null }, "missing"),
      ),
    ).rejects.toThrow();
    await expect(
      validate(request("file-list-paths", { files: [{ path: "a.txt", reason: "x" }] }, "missing")),
    ).rejects.toThrow();
  });
});
