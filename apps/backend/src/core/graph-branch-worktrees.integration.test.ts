/**
 * Isolated branch worktrees against real Git (item 403; slow tier by name):
 * worktrees inside a local environment are Git-excluded from the run's
 * checkout, share its object store (so the run's branch can fast-forward to
 * a branch's commit), and leave nothing behind once the run is removed.
 */
import { afterEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GraphAgentGuards } from "./graph-agent-guards.js";
import { GraphBranchWorktrees, graphBranchAbsolutePath } from "./graph-branch-worktrees.js";
import { graphEnvironmentFixture } from "./graph-run-test-support.js";
import type { Environment } from "./models.js";
import { runCommand } from "./shell.js";

const RUN = "run-integration";
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function git(cwd: string, args: string[]): Promise<string> {
  return (await runCommand("git", args, { cwd, timeoutMs: 30_000 })).stdout.trim();
}

async function repository(): Promise<{ root: string; environment: Environment }> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-graph-branches-"));
  roots.push(root);
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.invalid"]);
  await git(root, ["config", "user.name", "Test"]);
  await fs.writeFile(path.join(root, "README.md"), "base\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-q", "-m", "base"]);
  const environment = graphEnvironmentFixture({
    worktreePath: root,
    branch: "main",
  }) as Environment;
  return { root, environment };
}

test("branch worktrees are excluded, share objects with the run's branch, and are removed with the run", async () => {
  const { root, environment } = await repository();
  const worktrees = new GraphBranchWorktrees({
    storage: { getEnvironment: async () => environment },
    fence: { beginMutation: () => () => undefined },
  });
  const base = await git(root, ["rev-parse", "HEAD"]);
  const first = await worktrees.create(
    environment,
    { id: RUN },
    { nodeId: "implement", iteration: 1, branchKey: "sample.1" },
    base,
  );
  const second = await worktrees.create(
    environment,
    { id: RUN },
    { nodeId: "implement", iteration: 1, branchKey: "sample.2" },
    base,
  );
  const firstDirectory = graphBranchAbsolutePath(environment, first.path);
  expect(await git(firstDirectory, ["symbolic-ref", "--short", "HEAD"])).toBe(first.branch);
  expect(await git(firstDirectory, ["rev-parse", "HEAD"])).toBe(base);
  // The run's checkout does not see the branches as changes.
  expect(await git(root, ["status", "--porcelain"])).toBe("");
  expect((await worktrees.list(environment)).map((entry) => entry.path).sort()).toEqual(
    [first.path, second.path].sort(),
  );

  // A branch commits in its worktree; the guards certify it from the root.
  await fs.writeFile(path.join(firstDirectory, "feature.txt"), "one\n");
  await git(firstDirectory, ["add", "feature.txt"]);
  await git(firstDirectory, ["commit", "-q", "-m", "feature"]);
  const commit = await git(firstDirectory, ["rev-parse", "HEAD"]);
  const guards = new GraphAgentGuards({
    probe: async () => ({ status: "clean", head: base }),
    git: (_id, args) => git(root, args),
  });
  const node = {
    id: "implement",
    workspaceAccess: "write" as const,
    isolation: "worktree" as const,
  };
  expect(
    await guards.refusal({
      environmentId: environment.id,
      node,
      baseline: {
        headRef: base,
        pathsDigest: "0".repeat(64),
        paths: [],
        capturedAt: new Date().toISOString(),
      },
      worktree: first,
    }),
  ).toBeNull();
  await fs.writeFile(path.join(firstDirectory, "scratch.txt"), "left over\n");
  const refusal = await guards.refusal({
    environmentId: environment.id,
    node,
    baseline: {
      headRef: base,
      pathsDigest: "0".repeat(64),
      paths: [],
      capturedAt: new Date().toISOString(),
    },
    worktree: first,
  });
  expect(refusal?.message).toContain("scratch.txt");

  // The run's branch fast-forwards to the branch's commit: one object store.
  await git(root, ["merge", "--ff-only", "--quiet", commit]);
  expect(await git(root, ["rev-parse", "HEAD"])).toBe(commit);

  // A restart of the same position starts from the base again.
  const again = await worktrees.create(
    environment,
    { id: RUN },
    { nodeId: "implement", iteration: 1, branchKey: "sample.1" },
    base,
  );
  expect(await git(graphBranchAbsolutePath(environment, again.path), ["rev-parse", "HEAD"])).toBe(
    base,
  );

  expect(await worktrees.removeRun(environment, RUN)).toBe(0);
  expect(await worktrees.list(environment)).toEqual([]);
  expect(await git(root, ["for-each-ref", "refs/heads/orkestrator-graph/"])).toBe("");
  await expect(fs.stat(path.join(root, ".orkestrator", "graph-branches", RUN))).rejects.toThrow();
  expect(await git(root, ["status", "--porcelain"])).toBe("");
});
