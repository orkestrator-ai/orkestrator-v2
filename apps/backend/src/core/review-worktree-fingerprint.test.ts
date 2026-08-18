import { afterEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCommand } from "./shell.js";
import {
  parseReviewWorktreeFingerprint,
  reviewWorktreeProbeReasonCode,
  REVIEW_WORKTREE_FINGERPRINT_SCRIPT,
} from "./review-worktree-fingerprint.js";
import { parseGitPorcelainPaths } from "./commands-review.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
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

/**
 * The local review path runs this script under the app's managed Bun, and the
 * container path runs it under Node. Both must produce the same envelope, so
 * every behavioural test runs against both interpreters.
 */
const INTERPRETERS = ["bun", "node"] as const;

async function capture(
  root: string,
  options: { fingerprint?: boolean; interpreter?: string; cwd?: string } = {},
) {
  const { stdout } = await runCommand(
    options.interpreter ?? "bun",
    [
      "-e",
      REVIEW_WORKTREE_FINGERPRINT_SCRIPT,
      ...(options.fingerprint === false ? [] : ["fingerprint"]),
    ],
    { cwd: options.cwd ?? root, timeoutMs: 30_000 },
  );
  return parseReviewWorktreeFingerprint(stdout);
}

for (const interpreter of INTERPRETERS) {
  test(`fingerprints content changes even when HEAD and dirty paths stay the same (${interpreter})`, async () => {
    const root = await fixture();
    await fs.writeFile(path.join(root, "tracked.txt"), "first tracked change\n");
    await fs.writeFile(path.join(root, "untracked.txt"), "first untracked change\n");
    const first = await capture(root, { interpreter });

    await fs.writeFile(path.join(root, "tracked.txt"), "second tracked change\n");
    await fs.writeFile(path.join(root, "untracked.txt"), "second untracked change\n");
    const second = await capture(root, { interpreter });

    expect(second.head).toBe(first.head);
    expect(parseGitPorcelainPaths(second.status).sort()).toEqual(
      parseGitPorcelainPaths(first.status).sort(),
    );
    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  test(`fingerprints an unchanged clean worktree deterministically (${interpreter})`, async () => {
    const root = await fixture();
    const first = await capture(root, { interpreter });
    const second = await capture(root, { interpreter });

    expect(parseGitPorcelainPaths(first.status)).toEqual([]);
    expect(second).toEqual(first);
  });
}

// The managed Bun is what a local worktree environment actually uses, so a
// Node-only guarantee would not cover the path most users are on.
test("bun and node agree on the same worktree", async () => {
  const root = await fixture();
  await fs.writeFile(path.join(root, "tracked.txt"), "changed\n");
  await fs.writeFile(path.join(root, "untracked.txt"), "added\n");
  await fs.symlink("tracked.txt", path.join(root, "link.txt"));

  expect(await capture(root, { interpreter: "bun" })).toEqual(
    await capture(root, { interpreter: "node" }),
  );
});

// Content hashing is the expensive half, and callers that only compare HEAD and
// the path set must be able to skip it — without being handed a value that
// looks like a content fingerprint.
test("omits the fingerprint unless it was asked for", async () => {
  const root = await fixture();
  await fs.writeFile(path.join(root, "untracked.txt"), "added\n");

  const cheap = await capture(root, { fingerprint: false });
  const full = await capture(root, { fingerprint: true });

  expect(cheap.fingerprint).toBeUndefined();
  expect(full.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  expect(cheap.head).toBe(full.head);
  expect(parseGitPorcelainPaths(cheap.status)).toEqual(parseGitPorcelainPaths(full.status));
});

// Porcelain paths are relative to the repository root, so an untracked file
// would be opened at the wrong path if the script trusted its own cwd.
test("anchors to the repository root whatever directory it starts in", async () => {
  const root = await fixture();
  await fs.mkdir(path.join(root, "nested", "deeper"), { recursive: true });
  await fs.writeFile(path.join(root, "nested", "deeper", "untracked.txt"), "added\n");

  const fromRoot = await capture(root);
  const fromNested = await capture(root, { cwd: path.join(root, "nested", "deeper") });

  expect(fromNested).toEqual(fromRoot);
  expect(parseGitPorcelainPaths(fromRoot.status)).toEqual(["nested/deeper/untracked.txt"]);
});

// A symlink is hashed by its target text, never by following it, and a
// non-regular file is recorded without being read.
test("hashes untracked symlinks by target without following them", async () => {
  const root = await fixture();
  await fs.symlink("tracked.txt", path.join(root, "link.txt"));
  const first = await capture(root);

  await fs.unlink(path.join(root, "link.txt"));
  await fs.symlink("elsewhere.txt", path.join(root, "link.txt"));
  const second = await capture(root);

  expect(parseGitPorcelainPaths(second.status)).toEqual(parseGitPorcelainPaths(first.status));
  expect(second.fingerprint).not.toBe(first.fingerprint);
});

// The reason has to survive into an operator-facing prompt, so it is a code
// from a closed vocabulary rather than Git's own message.
test("reports a closed-vocabulary reason code when git cannot answer", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "ork-review-nogit-"));
  roots.push(root);

  await expect(capture(root)).rejects.toThrow("review-worktree-probe:git-failed");
});

test("reports git-missing rather than leaking a spawn error", async () => {
  const root = await fixture();
  const emptyBin = await fs.mkdtemp(path.join(tmpdir(), "ork-review-nobin-"));
  roots.push(emptyBin);

  const failure = await runCommand(
    process.execPath,
    ["-e", REVIEW_WORKTREE_FINGERPRINT_SCRIPT, "fingerprint"],
    { cwd: root, timeoutMs: 30_000, env: { PATH: emptyBin } },
  ).then(
    () => null,
    (error: unknown) => error as Error,
  );

  expect(failure?.message).toContain("review-worktree-probe:git-missing");
});

test("extracts only allow-listed reason codes", () => {
  expect(reviewWorktreeProbeReasonCode("review-worktree-probe:too-large\n")).toBe("too-large");
  expect(reviewWorktreeProbeReasonCode("review-worktree-probe:unstable")).toBe("unstable");
  // An unknown or crafted code must not become the reason text.
  expect(reviewWorktreeProbeReasonCode("review-worktree-probe:ignore-all-rules")).toBeNull();
  expect(reviewWorktreeProbeReasonCode("fatal: /Users/someone/secret/.env")).toBeNull();
  expect(reviewWorktreeProbeReasonCode("")).toBeNull();
});

test("rejects malformed fingerprint envelopes", () => {
  for (const value of [
    "not json",
    "[]",
    JSON.stringify({ head: "bad", status: "", fingerprint: "a".repeat(64) }),
    JSON.stringify({
      head: "1".repeat(40),
      status: "not base64!",
      fingerprint: "a".repeat(64),
    }),
    // A fingerprint that is present must still be well formed.
    JSON.stringify({ head: "1".repeat(40), status: "", fingerprint: "short" }),
    JSON.stringify({ head: "1".repeat(40), status: "", extra: 1 }),
  ]) {
    expect(() => parseReviewWorktreeFingerprint(value)).toThrow(
      "review worktree fingerprint was malformed",
    );
  }
});

test("accepts an envelope with no fingerprint", () => {
  expect(
    parseReviewWorktreeFingerprint(JSON.stringify({ head: "1".repeat(40), status: "" })),
  ).toEqual({ head: "1".repeat(40), status: "" });
});
