import { afterEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCommand } from "./shell.js";
import {
  parseReviewWorktreeFingerprint,
  REVIEW_WORKTREE_FINGERPRINT_SCRIPT,
} from "./review-worktree-fingerprint.js";
import { parseGitPorcelainPaths } from "./commands-review.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    fs.rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "ork-review-fingerprint-"));
  roots.push(root);
  await runCommand("git", ["init", "-q"], { cwd: root });
  await runCommand("git", ["config", "user.name", "Review Test"], { cwd: root });
  await runCommand("git", ["config", "user.email", "review@example.invalid"], { cwd: root });
  await fs.writeFile(path.join(root, "tracked.txt"), "base\n");
  await runCommand("git", ["add", "tracked.txt"], { cwd: root });
  await runCommand("git", ["commit", "-qm", "base"], { cwd: root });
  return root;
}

async function capture(root: string) {
  const { stdout } = await runCommand(
    "node",
    ["-e", REVIEW_WORKTREE_FINGERPRINT_SCRIPT],
    { cwd: root, timeoutMs: 30_000 },
  );
  return parseReviewWorktreeFingerprint(stdout);
}

test("fingerprints content changes even when HEAD and dirty paths stay the same", async () => {
  const root = await fixture();
  await fs.writeFile(path.join(root, "tracked.txt"), "first tracked change\n");
  await fs.writeFile(path.join(root, "untracked.txt"), "first untracked change\n");
  const first = await capture(root);

  await fs.writeFile(path.join(root, "tracked.txt"), "second tracked change\n");
  await fs.writeFile(path.join(root, "untracked.txt"), "second untracked change\n");
  const second = await capture(root);

  expect(second.head).toBe(first.head);
  expect(parseGitPorcelainPaths(second.status).sort())
    .toEqual(parseGitPorcelainPaths(first.status).sort());
  expect(second.fingerprint).not.toBe(first.fingerprint);
});

test("fingerprints an unchanged clean worktree deterministically", async () => {
  const root = await fixture();
  const first = await capture(root);
  const second = await capture(root);

  expect(parseGitPorcelainPaths(first.status)).toEqual([]);
  expect(second).toEqual(first);
});

test("rejects malformed fingerprint envelopes", () => {
  for (const value of [
    "not json",
    JSON.stringify({ head: "bad", status: "", fingerprint: "a".repeat(64) }),
    JSON.stringify({
      head: "1".repeat(40), status: "not base64!", fingerprint: "a".repeat(64),
    }),
  ]) {
    expect(() => parseReviewWorktreeFingerprint(value)).toThrow(
      "review worktree fingerprint was malformed",
    );
  }
});
