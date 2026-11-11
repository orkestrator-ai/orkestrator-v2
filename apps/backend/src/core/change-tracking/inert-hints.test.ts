import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DiffStatsTarget } from "../diff-stats-service.js";
import {
  ContainerCaptureExecutor,
  encodePath,
  type CaptureExecutor,
  type Manifest,
} from "./capture.js";
import { filterablePaths, manifestCovers, type WorktreeActivity } from "./inert-hints.js";
import { createHarness, git, type Harness } from "./service-test-support.js";

/**
 * Todo 7840: a provisional capture whose hint names only Git-ignored output
 * is skipped, and nothing that could move the tree is.
 */

// Real Git processes; Bun's 5 s default is too tight under aggregate load.
setDefaultTimeout(30_000);

const harnesses: Harness[] = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.cleanup();
});

const hint = (...paths: string[]): WorktreeActivity => ({ paths, gitMetadata: false });

function manifest(entries: string[], omitted: string[] = [], unstable: string[] = []): Manifest {
  const id = (name: string) => encodePath(new TextEncoder().encode(name));
  return {
    v: 1,
    root: "",
    entries: entries.map((name) => ({ p: id(name), m: "100644", o: "x", s: 0, t: 1 })),
    omitted: omitted.map((name) => ({ p: id(name), reason: "too-large", size: null, stamp: null })),
    unstable: unstable.map(id),
  };
}

describe("filterablePaths", () => {
  test("keeps exact worktree-relative names, without a trailing slash", () => {
    expect(filterablePaths(hint("dist/out.js", "coverage/", "node_modules/.cache/x"))).toEqual([
      "dist/out.js",
      "coverage",
      "node_modules/.cache/x",
    ]);
  });

  test("anything it cannot reason about is not filterable", () => {
    expect(filterablePaths({ paths: null, gitMetadata: false })).toBeNull();
    expect(filterablePaths({ paths: [], gitMetadata: false })).toBeNull();
    // The burst also touched the index or HEAD, which the paths do not name.
    expect(filterablePaths({ paths: ["dist/a.js"], gitMetadata: true })).toBeNull();
    for (const name of [
      ".gitignore",
      "dist/.gitignore",
      "",
      "/abs/dist/a.js",
      "../outside/a.js",
      "dist/./a.js",
      "dist//a.js",
      ".git/info/exclude",
      "sub/.git/index",
      "dist/�.js",
    ]) {
      expect(filterablePaths(hint("dist/out.js", name))).toBeNull();
    }
  });
});

describe("manifestCovers", () => {
  test("matches a recorded path, an omitted or unstable one, and a directory above one", () => {
    const covered = manifest(["src/a.ts", "dist/forced/keep.js"], ["big/blob.bin"], ["tmp/u.txt"]);
    expect(manifestCovers(covered, ["src/a.ts"])).toBe(true);
    expect(manifestCovers(covered, ["dist"])).toBe(true);
    expect(manifestCovers(covered, ["dist/forced"])).toBe(true);
    expect(manifestCovers(covered, ["big/blob.bin"])).toBe(true);
    expect(manifestCovers(covered, ["tmp"])).toBe(true);
    expect(manifestCovers(covered, ["dist/out.js", "coverage/lcov.info"])).toBe(false);
    // A sibling sharing a prefix is not a directory above the entry.
    expect(manifestCovers(covered, ["dis", "src/a"])).toBe(false);
  });

  test("a path inside a recorded entry is covered (a nested repository, a gitlink)", () => {
    const covered = manifest(["vendor/lib"], ["nest/"]);
    expect(manifestCovers(covered, ["nest/x"])).toBe(true);
    expect(manifestCovers(covered, ["nest"])).toBe(true);
    expect(manifestCovers(covered, ["vendor/lib/src/x.c"])).toBe(true);
    expect(manifestCovers(covered, ["vendor/other.c", "nester/x"])).toBe(false);
  });

  test("handles names that are not valid UTF-8", () => {
    const bytes = new Uint8Array([0x64, 0x2f, 0xff, 0x2e, 0x6a, 0x73]); // d/\xff.js
    const covered: Manifest = {
      v: 1,
      root: "",
      entries: [{ p: encodePath(bytes), m: "100644", o: "x", s: 0, t: 0 }],
      omitted: [],
      unstable: [],
    };
    expect(manifestCovers(covered, ["d"])).toBe(true);
    expect(manifestCovers(covered, ["e"])).toBe(false);
  });
});

describe("WorktreeChangeOwner.hintCannotMoveTree", () => {
  async function setup() {
    const h = createHarness({ policy: { provisionalSpacingLocalMs: 0 } });
    harnesses.push(h);
    writeFileSync(
      join(h.repo, ".gitignore"),
      "dist/\ncoverage/\nnode_modules/\n*.log\nbuild/*\n!build/keep.txt\n",
    );
    mkdirSync(join(h.repo, "dist"), { recursive: true });
    writeFileSync(join(h.repo, "dist", "forced.js"), "forced\n");
    git(h.repo, "add", ".gitignore");
    git(h.repo, "add", "-f", "dist/forced.js");
    git(h.repo, "commit", "-qm", "ignore output");
    const identity = await h.service.registry.resolve({ kind: "local", worktreePath: h.repo });
    const owner = h.service.registry.owner(identity!);
    // The previous manifest every check compares with.
    const first = await owner.capture({ purpose: "refresh", deadlineMs: 30_000 });
    expect(first.kind).toBe("published");
    return { h, owner };
  }

  test("writes only to ignored, unrecorded output cannot move the tree", async () => {
    const { h, owner } = await setup();
    mkdirSync(join(h.repo, "coverage"), { recursive: true });
    mkdirSync(join(h.repo, "node_modules", ".cache"), { recursive: true });
    writeFileSync(join(h.repo, "dist", "out.js"), "built\n");
    writeFileSync(join(h.repo, "coverage", "lcov.info"), "TN:\n");
    writeFileSync(join(h.repo, "node_modules", ".cache", "x"), "cache\n");
    writeFileSync(join(h.repo, "test.log"), "log\n");
    mkdirSync(join(h.repo, "build"), { recursive: true });
    writeFileSync(join(h.repo, "build", "junk.o"), "junk\n");
    expect(
      await owner.hintCannotMoveTree(
        hint(
          "dist/out.js",
          "coverage/lcov.info",
          "coverage",
          "node_modules/.cache/x",
          "node_modules",
          "test.log",
          "build/junk.o",
        ),
      ),
    ).toBe(true);
    // A deleted file nobody recorded cannot either.
    expect(await owner.hintCannotMoveTree(hint("dist/gone.js"))).toBe(true);
  });

  test("anything Git or the previous manifest can see still captures", async () => {
    const { h, owner } = await setup();
    writeFileSync(join(h.repo, "dist", "out.js"), "built\n");
    writeFileSync(join(h.repo, "visible.txt"), "new\n");
    mkdirSync(join(h.repo, "build"), { recursive: true });
    writeFileSync(join(h.repo, "build", "junk.o"), "junk\n");
    writeFileSync(join(h.repo, "build", "keep.txt"), "keep\n");
    const cases: Array<[string, WorktreeActivity]> = [
      ["a visible untracked file", hint("dist/out.js", "visible.txt")],
      ["a tracked file", hint("a.txt")],
      ["a tracked file under an ignored directory", hint("dist/forced.js")],
      ["an ignored directory holding a tracked file", hint("dist")],
      ["a directory a negated rule partly un-ignores", hint("build")],
      ["a path a negated rule un-ignores", hint("build/junk.o", "build/keep.txt")],
      ["an ignore-rule file", hint(".gitignore")],
      ["a burst that also changed Git metadata", { paths: ["dist/out.js"], gitMetadata: true }],
      ["a burst with unknown paths", { paths: null, gitMetadata: false }],
    ];
    for (const [name, activity] of cases) {
      expect({ name, inert: await owner.hintCannotMoveTree(activity) }).toEqual({
        name,
        inert: false,
      });
    }
  });

  test("a deleted tracked file and a newly force-added one still capture", async () => {
    const { h, owner } = await setup();
    rmSync(join(h.repo, "a.txt"));
    expect(await owner.hintCannotMoveTree(hint("a.txt"))).toBe(false);
    writeFileSync(join(h.repo, "dist", "late.js"), "late\n");
    git(h.repo, "add", "-f", "dist/late.js");
    expect(await owner.hintCannotMoveTree(hint("dist/late.js"))).toBe(false);
  });

  test("a path the previous manifest recorded captures even once Git ignores it", async () => {
    const { h, owner } = await setup();
    writeFileSync(join(h.repo, "notes.txt"), "draft\n");
    expect((await owner.capture({ purpose: "refresh", deadlineMs: 30_000 })).kind).toBe(
      "published",
    );
    writeFileSync(
      join(h.repo, ".gitignore"),
      "dist/\ncoverage/\nnode_modules/\n*.log\nnotes.txt\n",
    );
    writeFileSync(join(h.repo, "notes.txt"), "draft two\n");
    expect(await owner.hintCannotMoveTree(hint("notes.txt"))).toBe(false);
  });

  test("a path inside a submodule or an untracked nested repository captures", async () => {
    const { h, owner } = await setup();
    for (const name of ["vendor/lib", "nest"]) {
      const nested = join(h.repo, name);
      mkdirSync(nested, { recursive: true });
      git(nested, "init", "-q", "-b", "main");
      writeFileSync(join(nested, "x.txt"), "x\n");
      git(nested, "add", ".");
      git(nested, "commit", "-qm", "nested");
    }
    // `check-ignore` refuses a path inside a submodule; failure captures.
    git(h.repo, "-c", "advice.addEmbeddedRepo=false", "add", "vendor/lib");
    expect(await owner.hintCannotMoveTree(hint("vendor/lib/x.txt"))).toBe(false);
    // An untracked nested repository is one `nest/` record, not ignored.
    expect(await owner.hintCannotMoveTree(hint("nest/x.txt"))).toBe(false);
  });

  test("a container executor offers no probe, so its hints always capture", () => {
    const executor: CaptureExecutor = new ContainerCaptureExecutor("c", "/workspace");
    expect(executor.ignoredAndUnlisted).toBeUndefined();
  });
});

describe("provisional captures from watcher hints", () => {
  async function runningTurn() {
    const h = createHarness({ policy: { provisionalSpacingLocalMs: 0 } });
    harnesses.push(h);
    writeFileSync(join(h.repo, ".gitignore"), "dist/\n");
    git(h.repo, "add", ".gitignore");
    git(h.repo, "commit", "-qm", "ignore dist");
    await h.service.prepareTurnStart({
      environmentId: "env-1",
      logicalSessionKey: "env-env-1:tab",
      requestId: "inert",
      provider: "claude",
    });
    h.service.markTurnDispatched("env-1", "env-env-1:tab", "inert", "accepted");
    const target: DiffStatsTarget = {
      environmentId: "env-1",
      kind: "local",
      worktreePath: h.repo,
      comparisonRef: "main",
    };
    const captures = () =>
      (
        h
          .database()
          .db.query(
            "SELECT COUNT(*) AS n FROM change_capture_attempts WHERE purpose = 'provisional'",
          )
          .get() as { n: number }
      ).n;
    const send = (paths: string[] | null, gitMetadata = false) =>
      h.service.onDiffScanEvent({
        kind: "hint",
        target,
        paths,
        ...(gitMetadata ? { gitMetadata } : {}),
        at: new Date().toISOString(),
      });
    return { h, captures, send };
  }

  async function until(condition: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("condition not reached");
  }

  test("an ignored-only hint skips the capture; the next visible one still captures", async () => {
    const { h, captures, send } = await runningTurn();
    mkdirSync(join(h.repo, "dist"), { recursive: true });
    writeFileSync(join(h.repo, "dist", "out.js"), "built\n");
    send(["dist/out.js"]);
    await until(() => h.service.turns.provisionalInertSkips === 1);
    expect(captures()).toBe(0);

    // The skip left the spacing untouched, so a real edit captures at once.
    writeFileSync(join(h.repo, "a.txt"), "one\nedited\n");
    send(["a.txt"]);
    await until(() => captures() === 1);
    expect(h.service.turns.provisionalInertSkips).toBe(1);
  });

  test("ignored paths with Git metadata, or with no paths, capture as before", async () => {
    const { h, captures, send } = await runningTurn();
    mkdirSync(join(h.repo, "dist"), { recursive: true });
    writeFileSync(join(h.repo, "dist", "out.js"), "built\n");
    send(["dist/out.js"], true);
    await until(() => captures() === 1);
    send(null);
    await until(() => captures() === 2);
    expect(h.service.turns.provisionalInertSkips).toBe(0);
  });
});
