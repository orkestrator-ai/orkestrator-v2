import { expect, test } from "bun:test";
import {
  probeReviewWorktree,
  probeReviewWorktreeOnce,
} from "./review-worktree-probe.js";

const HEAD = "1111111111111111111111111111111111111111";
const FINGERPRINT = "a".repeat(64);

function invoker(results: Array<unknown | Error>) {
  const commands: Array<{ command: string; args?: Record<string, unknown> }> = [];
  let index = 0;
  const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    commands.push({ command, args });
    const next = results[Math.min(index, results.length - 1)];
    index += 1;
    if (next instanceof Error) throw next;
    return next as T;
  };
  return { invoke, commands };
}

test("reports a clean worktree and its head", async () => {
  const { invoke, commands } = invoker([{ head: HEAD, paths: [] }]);
  await expect(probeReviewWorktreeOnce(invoke, "env-1")).resolves.toEqual({
    status: "clean",
    head: HEAD,
  });
  expect(commands).toEqual([
    { command: "get_environment_uncommitted_paths", args: { environmentId: "env-1" } },
  ]);
});

test("reports the uncommitted paths verbatim", async () => {
  const { invoke } = invoker([{
    head: HEAD,
    paths: ["src/a.ts", "docs/b.md"],
    fingerprint: FINGERPRINT,
  }]);
  await expect(probeReviewWorktreeOnce(invoke, "env-1")).resolves.toEqual({
    status: "dirty",
    head: HEAD,
    paths: ["src/a.ts", "docs/b.md"],
    fingerprint: FINGERPRINT,
  });
});

// An unusable answer must not be read as cleanliness: a review told the tree
// was clean stops looking for the uncommitted change.
test("treats an unusable probe result as unknown", async () => {
  for (const result of [
    { head: "not-a-sha", paths: [] },
    { head: HEAD, paths: "src/a.ts" },
    { head: HEAD, paths: [1] },
    { head: HEAD, paths: [], fingerprint: "not-a-fingerprint" },
    {},
    null,
  ]) {
    const { invoke } = invoker([result]);
    await expect(probeReviewWorktreeOnce(invoke, "env-1")).resolves.toEqual({
      status: "unknown",
      reason: "the worktree probe returned an unusable result",
    });
  }
});

// The failure message can quote repository paths, so only the class name is
// carried into a prompt.
test("keeps repository text out of a failed probe's reason", async () => {
  const failure = new Error("fatal: /Users/someone/secret-project/.env is unreadable");
  failure.name = "GitError: /Users/someone";
  const { invoke } = invoker([failure]);
  await expect(probeReviewWorktreeOnce(invoke, "env-1")).resolves.toEqual({
    status: "unknown",
    reason: "probe failed (GitErrorUserssomeone)",
  });
});

test("retries a transient failure and stops once the state is observed", async () => {
  const { invoke, commands } = invoker([
    new Error("busy"),
    { head: HEAD, paths: ["src/a.ts"] },
    { head: HEAD, paths: [] },
  ]);
  await expect(probeReviewWorktree(invoke, "env-1", 3)).resolves.toEqual({
    status: "dirty",
    head: HEAD,
    paths: ["src/a.ts"],
  });
  expect(commands).toHaveLength(2);
});

test("gives up after the bounded attempts", async () => {
  const { invoke, commands } = invoker([new Error("busy")]);
  await expect(probeReviewWorktree(invoke, "env-1", 3)).resolves.toMatchObject({
    status: "unknown",
  });
  expect(commands).toHaveLength(3);
});
