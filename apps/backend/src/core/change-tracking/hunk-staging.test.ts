import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChangeDiffHunk, DiffIdentity } from "@orkestrator/protocol/change-resources";
import { gitScopeResourceKey } from "./git-scopes.js";
import { spliceHunk } from "./hunk-staging.js";
import { createHarness, git, type Harness } from "./service-test-support.js";

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    // Staging refreshes the demanded Git scopes in the background.
    await harness.service.gitScopes.idle();
    harness.cleanup();
  }
});

const bytes = (text: string) => new TextEncoder().encode(text);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);

const LINES = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
const fileText = (lines: string[]) => `${lines.join("\n")}\n`;

/** A repo whose `a.txt` has two far-apart edits in the working tree (two hunks). */
function twoHunkRepo(): Harness {
  const h = createHarness();
  harnesses.push(h);
  writeFileSync(join(h.repo, "a.txt"), fileText(LINES));
  git(h.repo, "commit", "-qam", "twenty lines");
  const edited = [...LINES];
  edited[1] = "line 2 edited";
  edited[17] = "line 18 edited";
  writeFileSync(join(h.repo, "a.txt"), fileText(edited));
  return h;
}

async function liveDiff(
  h: Harness,
  scope: "unstaged" | "staged" | "uncommitted-net",
  path = "a.txt",
): Promise<{ identity: DiffIdentity; hunks: ChangeDiffHunk[] }> {
  const resourceKey = gitScopeResourceKey(scope, "env-1");
  await h.service.ensureResource(resourceKey);
  const resolved = await h.service.diffBodies.resolveLiveDetail({
    resourceKey,
    pathId: `u:${path}`,
  });
  if (resolved.kind !== "identity")
    throw new Error(`identity expected: ${JSON.stringify(resolved)}`);
  const body = await h.service.diffBodies.getDiff({ diffIdentityId: resolved.identity.id });
  if (body.kind !== "body") throw new Error("body expected");
  return { identity: resolved.identity, hunks: body.files[0]!.hunks };
}

function selector(hunks: ChangeDiffHunk[], index: number) {
  const hunk = hunks[index]!;
  return {
    index,
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
  };
}

const indexText = (h: Harness, path = "a.txt") => git(h.repo, "show", `:${path}`);

describe("spliceHunk", () => {
  test("replaces only the hunk's region and keeps every other byte", () => {
    const before = bytes("a\r\nb\nc\nd");
    const after = bytes("a\r\nB\nc\nD");
    // Second line only: `@@ -2,1 +2,1 @@`.
    expect(decode(spliceHunk(before, after, { start: 2, count: 1 }, { start: 2, count: 1 }))).toBe(
      "a\r\nB\nc\nd",
    );
    // Last line without a newline.
    expect(decode(spliceHunk(before, after, { start: 4, count: 1 }, { start: 4, count: 1 }))).toBe(
      "a\r\nb\nc\nD",
    );
  });

  test("insertions and deletions use the zero-length range convention", () => {
    const before = bytes("a\nb\n");
    const after = bytes("a\nnew\nb\n");
    // Pure insertion after line 1: `@@ -1,0 +2,1 @@`.
    expect(decode(spliceHunk(before, after, { start: 1, count: 0 }, { start: 2, count: 1 }))).toBe(
      "a\nnew\nb\n",
    );
    // And its reverse removes it again.
    expect(decode(spliceHunk(after, before, { start: 2, count: 1 }, { start: 1, count: 0 }))).toBe(
      "a\nb\n",
    );
    expect(() => spliceHunk(before, after, { start: 9, count: 1 }, { start: 2, count: 1 })).toThrow(
      RangeError,
    );
  });
});

describe("hunk staging", () => {
  test("stages one hunk, leaves the other unstaged, then unstages it", async () => {
    const h = twoHunkRepo();
    const unstaged = await liveDiff(h, "unstaged");
    expect(unstaged.hunks).toHaveLength(2);
    const workingBefore = readFileSync(join(h.repo, "a.txt"), "utf8");

    const staged = await h.service.hunkStaging.apply({
      diffIdentityId: unstaged.identity.id,
      action: "stage",
      hunk: selector(unstaged.hunks, 0),
    });
    expect(staged).toEqual({ kind: "applied", action: "stage", pathId: "u:a.txt" });
    const expectedIndex = [...LINES];
    expectedIndex[1] = "line 2 edited";
    expect(indexText(h)).toBe(fileText(expectedIndex));
    // The working tree is untouched.
    expect(readFileSync(join(h.repo, "a.txt"), "utf8")).toBe(workingBefore);

    // What is left unstaged is exactly the other hunk; the staged view has this one.
    const remaining = await liveDiff(h, "unstaged");
    expect(remaining.hunks).toHaveLength(1);
    expect(remaining.hunks[0]!.lines.some((line) => line.text === "line 18 edited")).toBe(true);
    const stagedView = await liveDiff(h, "staged");
    expect(stagedView.identity.scope).toBe("staged");
    expect(stagedView.hunks).toHaveLength(1);
    expect(stagedView.hunks[0]!.lines.some((line) => line.text === "line 2 edited")).toBe(true);

    const unstagedAgain = await h.service.hunkStaging.apply({
      diffIdentityId: stagedView.identity.id,
      action: "unstage",
      hunk: selector(stagedView.hunks, 0),
    });
    expect(unstagedAgain).toMatchObject({ kind: "applied", action: "unstage" });
    expect(indexText(h)).toBe(fileText(LINES));
    expect(readFileSync(join(h.repo, "a.txt"), "utf8")).toBe(workingBefore);
  });

  test("an uncommitted-net diff stages while the index still matches HEAD", async () => {
    const h = twoHunkRepo();
    const diff = await liveDiff(h, "uncommitted-net");
    expect(diff.hunks).toHaveLength(2);
    const result = await h.service.hunkStaging.apply({
      diffIdentityId: diff.identity.id,
      action: "stage",
      hunk: selector(diff.hunks, 1),
    });
    expect(result).toMatchObject({ kind: "applied" });
    expect(indexText(h)).toContain("line 18 edited");
    expect(indexText(h)).not.toContain("line 2 edited");

    // The same reviewed diff is no longer against the index: refused, not merged.
    const again = await h.service.hunkStaging.apply({
      diffIdentityId: diff.identity.id,
      action: "stage",
      hunk: selector(diff.hunks, 0),
    });
    expect(again).toEqual({
      kind: "error",
      error: { code: "precondition-failed", reasonKey: "changes.staging.index-mismatch" },
    });
    expect(indexText(h)).not.toContain("line 2 edited");
  });

  test("stale operations are rejected and change nothing", async () => {
    const h = twoHunkRepo();
    const diff = await liveDiff(h, "unstaged");
    const original = indexText(h);

    // A hunk the identity does not have at that index.
    const wrongHunk = await h.service.hunkStaging.apply({
      diffIdentityId: diff.identity.id,
      action: "stage",
      hunk: { ...selector(diff.hunks, 0), newLines: diff.hunks[0]!.newLines + 1 },
    });
    expect(wrongHunk).toMatchObject({
      kind: "error",
      error: { code: "stale-revision", reasonKey: "changes.staging.hunk-changed" },
    });

    // The working file changed after the review.
    writeFileSync(join(h.repo, "a.txt"), `${readFileSync(join(h.repo, "a.txt"), "utf8")}tail\n`);
    const worktreeMoved = await h.service.hunkStaging.apply({
      diffIdentityId: diff.identity.id,
      action: "stage",
      hunk: selector(diff.hunks, 0),
    });
    expect(worktreeMoved).toMatchObject({
      kind: "error",
      error: { code: "precondition-failed", reasonKey: "changes.staging.worktree-changed" },
    });

    // The index changed after the review (another `git add`).
    const fresh = await liveDiff(h, "unstaged");
    git(h.repo, "add", "a.txt");
    const indexMoved = await h.service.hunkStaging.apply({
      diffIdentityId: fresh.identity.id,
      action: "stage",
      hunk: selector(fresh.hunks, 0),
    });
    expect(indexMoved).toMatchObject({
      kind: "error",
      error: { code: "precondition-failed", reasonKey: "changes.staging.index-changed" },
    });
    git(h.repo, "reset", "-q", "a.txt");
    expect(indexText(h)).toBe(original);

    // Unknown identities and an action the identity does not support.
    expect(
      await h.service.hunkStaging.apply({
        diffIdentityId: "diff_missing",
        action: "stage",
        hunk: selector(fresh.hunks, 0),
      }),
    ).toMatchObject({ kind: "error", error: { code: "not-found" } });
    const current = await liveDiff(h, "unstaged");
    expect(
      await h.service.hunkStaging.apply({
        diffIdentityId: current.identity.id,
        action: "unstage",
        hunk: selector(current.hunks, 0),
      }),
    ).toMatchObject({
      kind: "error",
      error: { reasonKey: "changes.staging.unsupported-identity" },
    });
  });

  test("whole-file changes and converted working files are refused", async () => {
    const h = createHarness();
    harnesses.push(h);
    writeFileSync(join(h.repo, "new.txt"), "brand new\n");
    const added = await liveDiff(h, "unstaged", "new.txt");
    expect(added.identity.kind === "file" && added.identity.before.state).toBe("absent");
    expect(
      await h.service.hunkStaging.apply({
        diffIdentityId: added.identity.id,
        action: "stage",
        hunk: selector(added.hunks, 0),
      }),
    ).toMatchObject({ kind: "error", error: { reasonKey: "changes.staging.whole-file" } });

    // Git would store these working bytes with LF endings, not as they are.
    git(h.repo, "config", "core.autocrlf", "true");
    git(h.repo, "config", "core.safecrlf", "false");
    writeFileSync(join(h.repo, "a.txt"), "one\r\nchanged\r\n");
    const converted = await liveDiff(h, "unstaged");
    expect(
      await h.service.hunkStaging.apply({
        diffIdentityId: converted.identity.id,
        action: "stage",
        hunk: selector(converted.hunks, 0),
      }),
    ).toMatchObject({ kind: "error", error: { reasonKey: "changes.staging.git-conversion" } });
    expect(indexText(h)).toBe("one\ntwo\n");
  });

  test("a path with no unstaged change resolves as not-found", async () => {
    const h = createHarness();
    harnesses.push(h);
    writeFileSync(join(h.repo, "a.txt"), "one\nstaged\n");
    git(h.repo, "add", "a.txt");
    const resourceKey = gitScopeResourceKey("unstaged", "env-1");
    await h.service.ensureResource(resourceKey);
    expect(
      await h.service.diffBodies.resolveLiveDetail({ resourceKey, pathId: "u:a.txt" }),
    ).toMatchObject({ kind: "error", error: { code: "not-found" } });
  });
});
