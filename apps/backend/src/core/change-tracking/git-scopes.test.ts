import { afterEach, describe, expect, test, spyOn } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarness, git, type Harness } from "./service-test-support.js";
import { environmentChangeResourceKey } from "@orkestrator/protocol/change-resources";
import { createGitFetchScheduler } from "../diff-stats-tracking.js";
import { getLocalGitStatusDetailed } from "../commands-files.js";
import { committedHead, gitScopeResourceKey } from "./git-scopes.js";

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

/** The environment's own measurement (`environment-net`) against `base`, as a scan reports it. */
async function scanned(h: Harness, base: string) {
  const detailed = await getLocalGitStatusDetailed(h.repo, base, true, createGitFetchScheduler());
  const now = new Date().toISOString();
  h.service.onDiffScanEvent({
    kind: "scanned",
    target: { environmentId: "env-1", comparisonRef: base, kind: "local", worktreePath: h.repo },
    result: {
      stats: {
        additions: detailed.changes.reduce((sum, row) => sum + row.additions, 0),
        deletions: detailed.changes.reduce((sum, row) => sum + row.deletions, 0),
        filesChanged: detailed.changes.length,
        truncated: detailed.truncated,
      },
      changes: detailed.changes,
      baseOid: detailed.baseOid,
    },
    changed: true,
    at: now,
    startedAt: now,
  });
  await h.service.environments.idle();
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

  test("committed-net is the environment's base to HEAD, without the working tree", async () => {
    const h = createHarness();
    harnesses.push(h);
    const base = git(h.repo, "rev-parse", "HEAD").trim();
    const key = gitScopeResourceKey("committed-net", "env-1");
    // No environment measurement yet: no base to compare against.
    await h.service.ensureResource(key);
    const before = h.service.getView({ resourceKey: key });
    if (before.kind !== "projection") throw new Error("projection expected");
    expect(before.projection.state).toBe("unavailable");
    expect(before.projection.reasonKeys).toContain("changes.reason.baseline-unavailable");

    writeFileSync(join(h.repo, "a.txt"), "one\ncommitted\n");
    git(h.repo, "commit", "-qam", "worker commit");
    const head = git(h.repo, "rev-parse", "HEAD").trim();
    writeFileSync(join(h.repo, "a.txt"), "one\ncommitted\nuncommitted\n");
    writeFileSync(join(h.repo, "new.txt"), "untracked\n");
    await scanned(h, base);
    expect(
      h.service.projections.selectedMeasurement(environmentChangeResourceKey("env-1"))?.totals
        .changedFiles,
    ).toBe(2);
    const committed = await measured(h, key);
    expect(committed.totals).toMatchObject({ changedFiles: 1, additions: { value: 1 } });
    expect(committedHead(committed.baselineVersion)).toBe(head);
    expect(committed.baselineVersion).toEndWith(`@${base}`);
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

test("committed live detail reads deleted and renamed blobs, independent of working bytes", async () => {
  const h = createHarness();
  harnesses.push(h);
  const base = git(h.repo, "rev-parse", "HEAD").trim();
  writeFileSync(join(h.repo, "deleted.txt"), "removed content\n");
  git(h.repo, "add", ".");
  git(h.repo, "commit", "-qm", "add deletion fixture");
  const before = git(h.repo, "rev-parse", "HEAD").trim();
  git(h.repo, "mv", "a.txt", "renamed.txt");
  git(h.repo, "rm", "deleted.txt");
  git(h.repo, "commit", "-qm", "rename and delete");
  await scanned(h, before);
  const key = gitScopeResourceKey("committed-net", "env-1");
  await measured(h, key);
  writeFileSync(join(h.repo, "renamed.txt"), "working sentinel\n");
  const view = h.service.getView({ resourceKey: key });
  if (view.kind !== "projection") throw new Error("projection expected");
  const rows = view.projection.filePage!.rows;
  expect(rows.some((row) => row.status === "renamed")).toBe(true);
  expect(rows.some((row) => row.status === "deleted")).toBe(true);
  for (const row of rows) {
    const detail = await h.service.diffBodies.resolveLiveDetail({
      resourceKey: key,
      rowId: row.rowId,
      revision: view.projection.revision,
    });
    expect(detail.kind).toBe("identity");
    if (detail.kind !== "identity") continue;
    const body = await h.service.diffBodies.getDiff({ diffIdentityId: detail.identity.id });
    expect(body.kind).toBe("body");
    expect(JSON.stringify(body)).not.toContain("working sentinel");
    if (row.status === "deleted") expect(JSON.stringify(body)).toContain("removed content");
  }
  expect(base).not.toBe(before);
});

test("live Git detail refuses filters and committed measurements missing their HEAD", async () => {
  const h = createHarness();
  harnesses.push(h);
  git(h.repo, "config", "filter.upper.clean", "tr a-z A-Z");
  writeFileSync(join(h.repo, ".gitattributes"), "a.txt filter=upper\n");
  writeFileSync(join(h.repo, "a.txt"), "changed\n");
  const filteredKey = gitScopeResourceKey("uncommitted-net", "env-1");
  await measured(h, filteredKey);
  expect(
    await h.service.diffBodies.resolveLiveDetail({ resourceKey: filteredKey, pathId: "u:a.txt" }),
  ).toMatchObject({ kind: "error", error: { reasonKey: "changes.reason.git-filter-unsupported" } });
  const base = git(h.repo, "rev-parse", "HEAD").trim();
  await scanned(h, base);
  const key = gitScopeResourceKey("committed-net", "env-1");
  writeFileSync(join(h.repo, "plain.txt"), "committed\n");
  git(h.repo, "add", "plain.txt");
  git(h.repo, "commit", "-qm", "plain commit");
  await measured(h, key);
  const selected = h.service.projections.selectedMeasurement.bind(h.service.projections);
  const spy = spyOn(h.service.projections, "selectedMeasurement").mockImplementation((resource) => {
    const measurement = selected(resource);
    return resource === key && measurement
      ? { ...measurement, baselineVersion: null }
      : measurement;
  });
  try {
    expect(
      await h.service.diffBodies.resolveLiveDetail({ resourceKey: key, pathId: "u:plain.txt" }),
    ).toMatchObject({ kind: "error", error: { code: "stale-revision" } });
  } finally {
    spy.mockRestore();
  }
});
