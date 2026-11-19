import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChangeDiffHunk, DiffIdentity } from "@orkestrator/protocol/change-resources";
import { environmentChangeResourceKey } from "@orkestrator/protocol/change-resources";
import type { CommandContext } from "../commands-context.js";
import { createCommandRegistry } from "../commands-registry.js";
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
  scope: "unstaged" | "staged" | "uncommitted-net" | "environment-net",
  path = "a.txt",
): Promise<{ identity: DiffIdentity; hunks: ChangeDiffHunk[]; truncated: boolean }> {
  const resourceKey =
    scope === "environment-net"
      ? environmentChangeResourceKey("env-1")
      : gitScopeResourceKey(scope, "env-1");
  await h.service.ensureResource(resourceKey);
  const resolved = await h.service.diffBodies.resolveLiveDetail({
    resourceKey,
    pathId: `u:${path}`,
  });
  if (resolved.kind !== "identity")
    throw new Error(`identity expected: ${JSON.stringify(resolved)}`);
  const body = await h.service.diffBodies.getDiff({ diffIdentityId: resolved.identity.id });
  if (body.kind !== "body") throw new Error("body expected");
  return {
    identity: resolved.identity,
    hunks: body.files[0]!.hunks,
    truncated: body.files[0]!.truncated,
  };
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

const indexText = (h: Harness, path = "a.txt") => git(h.repo, "show", `:0:${path}`);

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
    expect(
      h.events.flatMap(({ payload }) => {
        const event = payload as { kind?: string; resourceKey?: string; pathIds?: string[] };
        return event.kind === "content-invalidated" && event.pathIds?.includes("u:a.txt")
          ? [event.resourceKey]
          : [];
      }),
    ).toEqual([gitScopeResourceKey("staged", "env-1"), gitScopeResourceKey("unstaged", "env-1")]);
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

  test("unstage refuses when HEAD has advanced to the staged blob", async () => {
    const h = twoHunkRepo();
    git(h.repo, "add", "a.txt");
    const reviewed = await liveDiff(h, "staged");
    git(h.repo, "commit", "-qm", "commit the reviewed version");
    const expected = indexText(h);
    const result = await h.service.hunkStaging.apply({
      diffIdentityId: reviewed.identity.id,
      action: "unstage",
      hunk: selector(reviewed.hunks, 0),
    });
    expect(result).toMatchObject({
      kind: "error",
      error: { reasonKey: "changes.staging.head-changed" },
    });
    expect(indexText(h)).toBe(expected);
  });

  test("the registry stages an environment-net hunk and rejects a malformed selector", async () => {
    const h = twoHunkRepo();
    const at = new Date().toISOString();
    h.service.onDiffScanEvent({
      kind: "scanned",
      target: {
        kind: "local",
        environmentId: "env-1",
        worktreePath: h.repo,
        comparisonRef: "main",
      },
      result: {
        stats: { additions: 2, deletions: 2, filesChanged: 1, truncated: false },
        changes: [
          {
            path: "a.txt",
            filename: "a.txt",
            directory: "",
            status: "M",
            additions: 2,
            deletions: 2,
          },
        ],
        baseOid: git(h.repo, "rev-parse", "HEAD").trim(),
      },
      changed: true,
      at,
      startedAt: at,
    });
    await h.service.environments.idle();
    const reviewed = await liveDiff(h, "environment-net");
    const args = {
      diffIdentityId: reviewed.identity.id,
      action: "stage",
      hunk: selector(reviewed.hunks, 0),
    };
    const context = { runtime: { changeTracking: h.service } } as CommandContext;
    const stage = createCommandRegistry().get("changes_stage_hunk")!;
    await expect(
      stage({ ...args, hunk: { ...args.hunk, oldLines: "1" } }, context),
    ).rejects.toThrow("hunk.oldLines");
    expect(indexText(h)).toBe(fileText(LINES));
    expect(await stage(args, context)).toMatchObject({ kind: "applied", pathId: "u:a.txt" });
    expect(indexText(h)).toContain("line 2 edited");
    expect(indexText(h)).not.toContain("line 18 edited");
  });

  test("stage-zero index views preserve filenames beginning with a stage prefix", async () => {
    const h = twoHunkRepo();
    git(h.repo, "mv", "a.txt", "0:a.txt");
    git(h.repo, "commit", "-qm", "rename");
    const reviewed = await liveDiff(h, "unstaged", "0:a.txt");
    expect(reviewed.hunks).toHaveLength(2);
    expect(
      await h.service.hunkStaging.apply({
        diffIdentityId: reviewed.identity.id,
        action: "stage",
        hunk: selector(reviewed.hunks, 0),
      }),
    ).toMatchObject({ kind: "applied", pathId: "u:0:a.txt" });
    const staged = await liveDiff(h, "staged", "0:a.txt");
    expect(staged.hunks).toHaveLength(1);
    expect(staged.hunks[0]!.lines.some((line) => line.text === "line 2 edited")).toBe(true);
  });

  test("a regular file replaced by a same-byte symlink is refused", async () => {
    const h = twoHunkRepo();
    const reviewed = await liveDiff(h, "unstaged");
    renameSync(join(h.repo, "a.txt"), join(h.repo, "target.txt"));
    symlinkSync("target.txt", join(h.repo, "a.txt"));
    expect(
      await h.service.hunkStaging.apply({
        diffIdentityId: reviewed.identity.id,
        action: "stage",
        hunk: selector(reviewed.hunks, 0),
      }),
    ).toMatchObject({ kind: "error", error: { reasonKey: "changes.staging.worktree-changed" } });
    expect(indexText(h)).toBe(fileText(LINES));
  });

  test.each(["filter", "inspection-warning"])(
    "conversion inspection fails closed (%s)",
    async (mode) => {
      const h = twoHunkRepo();
      const reviewed = await liveDiff(h, "unstaged");
      git(h.repo, "config", "filter.other.clean", "cat");
      git(h.repo, "config", "filter.review.clean", "touch should-not-run");
      const worktree = (await h.service.registry.resolve({ kind: "local", worktreePath: h.repo }))!;
      const executor = h.service.registry.owner(worktree).executor;
      const fetch = executor.fetch.bind(executor);
      const changeAttributes = spyOn(executor, "fetch").mockImplementation(async (...args) => {
        const records = await fetch(...args);
        writeFileSync(
          join(h.repo, ".gitattributes"),
          mode === "filter" ? "a.txt filter=review\n" : "a.txt !invalid?\n",
        );
        return records;
      });
      try {
        expect(
          await h.service.hunkStaging.apply({
            diffIdentityId: reviewed.identity.id,
            action: "stage",
            hunk: selector(reviewed.hunks, 0),
          }),
        ).toMatchObject({ kind: "error", error: { reasonKey: "changes.staging.git-conversion" } });
      } finally {
        changeAttributes.mockRestore();
      }
      expect(existsSync(join(h.repo, "should-not-run"))).toBe(false);
      expect(indexText(h)).toBe(fileText(LINES));
    },
  );

  test("the index lock excludes Git writers through the final file check", async () => {
    const h = twoHunkRepo();
    const reviewed = await liveDiff(h, "unstaged");
    const identity = (await h.service.registry.resolve({ kind: "local", worktreePath: h.repo }))!;
    const executor = h.service.registry.owner(identity).executor;
    const fetch = executor.fetch.bind(executor);
    let attempted = false;
    const probe = spyOn(executor, "fetch").mockImplementation((...args) => {
      attempted = true;
      const competing = Bun.spawnSync(["git", "add", "--", "a.txt"], {
        cwd: h.repo,
        stderr: "pipe",
      });
      expect(competing.exitCode).not.toBe(0);
      expect(competing.stderr.toString()).toContain("index.lock");
      writeFileSync(join(h.repo, "a.txt"), "changed while holding the lock\n");
      return fetch(...args);
    });
    try {
      expect(
        await h.service.hunkStaging.apply({
          diffIdentityId: reviewed.identity.id,
          action: "stage",
          hunk: selector(reviewed.hunks, 0),
        }),
      ).toMatchObject({ kind: "error", error: { reasonKey: "changes.staging.worktree-changed" } });
      expect(attempted).toBe(true);
    } finally {
      probe.mockRestore();
    }
    expect(indexText(h)).toBe(fileText(LINES));
    expect(existsSync(join(h.repo, ".git", "index.lock"))).toBe(false);
  });

  test("concurrent hunk requests serialize and the second request sees the changed index", async () => {
    const h = twoHunkRepo();
    const reviewed = await liveDiff(h, "unstaged");
    const results = await Promise.all(
      [0, 1].map((index) =>
        h.service.hunkStaging.apply({
          diffIdentityId: reviewed.identity.id,
          action: "stage",
          hunk: selector(reviewed.hunks, index),
        }),
      ),
    );
    expect(results.filter(({ kind }) => kind === "applied")).toHaveLength(1);
    expect(results).toContainEqual({
      kind: "error",
      error: { code: "precondition-failed", reasonKey: "changes.staging.index-changed" },
    });
  });

  test("queued requests refuse a replacement checkout with matching file bytes", async () => {
    const h = twoHunkRepo();
    const reviewed = await liveDiff(h, "unstaged");
    const target = { kind: "local", worktreePath: h.repo } as const;
    const physical = (await h.service.registry.resolve(target))!;
    const executor = h.service.registry.owner(physical).executor;
    const fetch = executor.fetch.bind(executor);
    const checking = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const hold = spyOn(executor, "fetch").mockImplementation(async (...args) => {
      const records = await fetch(...args);
      checking.resolve();
      await resume.promise;
      return records;
    });
    const apply = (index: number) =>
      h.service.hunkStaging.apply({
        diffIdentityId: reviewed.identity.id,
        action: "stage",
        hunk: selector(reviewed.hunks, index),
      });
    const first = apply(0);
    await Promise.race([
      checking.promise,
      first.then(() => {
        throw new Error("first request never reached publication");
      }),
    ]);
    const admitted = Promise.withResolvers<void>();
    const resolve = h.service.registry.resolve.bind(h.service.registry);
    const observe = spyOn(h.service.registry, "resolve").mockImplementation(async (target) => {
      const current = await resolve(target);
      admitted.resolve();
      return current;
    });
    const moved = `${h.repo}-moved`;
    const second = apply(1);
    try {
      await admitted.promise;
      renameSync(h.repo, moved);
      git(moved, "clone", "--quiet", "--no-local", moved, h.repo);
      writeFileSync(join(h.repo, "a.txt"), readFileSync(join(moved, "a.txt")));
      resume.resolve();
      for (const result of await Promise.all([first, second])) {
        expect(result).toMatchObject({
          kind: "error",
          error: { reasonKey: "changes.error.owner-replaced" },
        });
      }
      expect(indexText(h)).toBe(fileText(LINES));
    } finally {
      resume.resolve();
      await Promise.allSettled([first, second]);
      observe.mockRestore();
      hold.mockRestore();
      rmSync(moved, { recursive: true, force: true });
    }
  });

  test("a truncated final hunk is refused", async () => {
    const h = twoHunkRepo();
    const before = Array.from({ length: 5_000 }, (_, line) => `line ${line}`);
    writeFileSync(join(h.repo, "a.txt"), fileText(before));
    git(h.repo, "commit", "-qam", "many lines");
    const after = before.map((line, index) => (index % 10 === 3 ? `${line} edited` : line));
    writeFileSync(join(h.repo, "a.txt"), fileText(after));
    const reviewed = await liveDiff(h, "unstaged");
    expect(reviewed.truncated).toBe(true);
    expect(
      await h.service.hunkStaging.apply({
        diffIdentityId: reviewed.identity.id,
        action: "stage",
        hunk: selector(reviewed.hunks, reviewed.hunks.length - 1),
      }),
    ).toMatchObject({ kind: "error", error: { reasonKey: "changes.staging.truncated" } });
    expect(indexText(h)).toBe(fileText(before));
  });

  test("an omitted unstaged path reports the untracked scan cap", async () => {
    const h = createHarness();
    harnesses.push(h);
    for (let index = 0; index <= 2_000; index++) {
      writeFileSync(join(h.repo, `u${String(index).padStart(4, "0")}`), "");
    }
    const resourceKey = gitScopeResourceKey("unstaged", "env-1");
    await h.service.ensureResource(resourceKey);
    expect(
      await h.service.diffBodies.resolveLiveDetail({ resourceKey, pathId: "u:u2000" }),
    ).toEqual({
      kind: "error",
      error: { code: "not-found", reasonKey: "changes.reason.untracked-scan-capped" },
    });
  });

  test("staging preserves unrelated entries in a split index", async () => {
    const h = twoHunkRepo();
    writeFileSync(join(h.repo, "other.txt"), "unrelated staged file\n");
    git(h.repo, "add", "other.txt");
    git(h.repo, "update-index", "--split-index");
    const reviewed = await liveDiff(h, "unstaged");
    expect(
      await h.service.hunkStaging.apply({
        diffIdentityId: reviewed.identity.id,
        action: "stage",
        hunk: selector(reviewed.hunks, 0),
      }),
    ).toMatchObject({ kind: "applied" });
    expect(indexText(h, "other.txt")).toBe("unrelated staged file\n");
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
    ).toMatchObject({
      kind: "error",
      error: { code: "not-found", reasonKey: "changes.reason.empty-index-scope" },
    });
  });
});
