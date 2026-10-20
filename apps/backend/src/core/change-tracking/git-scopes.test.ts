import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarness, git, type Harness } from "./service-test-support.js";
import { gitScopeResourceKey } from "./git-scopes.js";

const harnesses: Harness[] = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function measured(h: Harness, key: string) {
  await h.service.ensureResource(key);
  const measurement = h.service.projections.selectedMeasurement(key);
  if (!measurement) throw new Error(`no measurement for ${key}`);
  return measurement;
}

describe("Git source-control scopes", () => {
  test("H01: staged replacement with working bytes restored — uncommitted 0/0, staged and unstaged nonzero", async () => {
    const h = createHarness();
    harnesses.push(h);
    writeFileSync(join(h.repo, "a.txt"), "one\nstaged\n");
    git(h.repo, "add", "a.txt");
    writeFileSync(join(h.repo, "a.txt"), "one\ntwo\n");
    const uncommitted = await measured(h, gitScopeResourceKey("uncommitted-net", "env-1"));
    const staged = await measured(h, gitScopeResourceKey("staged", "env-1"));
    const unstaged = await measured(h, gitScopeResourceKey("unstaged", "env-1"));
    expect(uncommitted.totals.changedFiles).toBe(0);
    expect(uncommitted.totals.additions.value).toBe(0);
    expect(staged.totals).toMatchObject({
      changedFiles: 1,
      additions: { value: 1 },
      deletions: { value: 1 },
    });
    expect(unstaged.totals).toMatchObject({
      changedFiles: 1,
      additions: { value: 1 },
      deletions: { value: 1 },
    });
    // Each names its own immutable endpoints.
    expect(staged.baselineVersion).toMatch(/^HEAD@[0-9a-f]{40}$/);
    expect(unstaged.baselineVersion).toBe("index");
  });

  test("uncommitted-net includes untracked files; binaries keep identity without counts", async () => {
    const h = createHarness();
    harnesses.push(h);
    writeFileSync(join(h.repo, "new.txt"), "a\nb\n");
    writeFileSync(join(h.repo, "bin.dat"), Buffer.from([0, 1]));
    const uncommitted = await measured(h, gitScopeResourceKey("uncommitted-net", "env-1"));
    expect(uncommitted.totals.changedFiles).toBe(2);
    expect(uncommitted.totals.additions.value).toBe(2);
    const view = h.service.getView({
      resourceKey: gitScopeResourceKey("uncommitted-net", "env-1"),
    });
    if (view.kind !== "projection") throw new Error("projection expected");
    const binary = view.projection.filePage!.rows.find((row) => row.newPathDisplay === "bin.dat")!;
    expect(binary.additions.quality).toBe("not-applicable");
  });

  test("a commit compares with its first parent; a root commit with the empty tree", async () => {
    const h = createHarness();
    harnesses.push(h);
    const root = git(h.repo, "rev-parse", "HEAD").trim();
    writeFileSync(join(h.repo, "a.txt"), "one\ntwo\nthree\n");
    git(h.repo, "commit", "-qam", "second");
    const second = git(h.repo, "rev-parse", "HEAD").trim();
    const commit = await measured(h, gitScopeResourceKey("commit", "env-1", second));
    expect(commit.totals.additions.value).toBe(1);
    expect(commit.finality).toBe("final");
    const first = await measured(h, gitScopeResourceKey("commit", "env-1", root));
    expect(first.totals.additions.value).toBe(2);
    expect(first.baselineVersion).toContain("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  });

  test("an unknown commit is unavailable, never an empty success", async () => {
    const h = createHarness();
    harnesses.push(h);
    const key = gitScopeResourceKey("commit", "env-1", "f".repeat(40));
    await h.service.ensureResource(key);
    const view = h.service.getView({ resourceKey: key });
    if (view.kind !== "projection") throw new Error("projection expected");
    expect(view.projection.state).toBe("unavailable");
    expect(view.projection.measurementId).toBeNull();
  });
});
