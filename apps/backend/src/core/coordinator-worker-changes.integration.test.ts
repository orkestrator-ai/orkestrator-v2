import { expect, test, spyOn } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { createHarness, git } from "./change-tracking/service-test-support.js";
import { createGitFetchScheduler } from "./diff-stats-tracking.js";
import { getLocalGitStatusDetailed } from "./commands-files.js";
import type { CommandContext } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";
import { createEnvironment, createProject, StorageService } from "./storage.js";

/** A real worker checkout measured by change tracking, and the controller read over it. */
async function withWorker(
  edit: (repo: string) => void,
  run: (
    read: (
      options?: Record<string, unknown>,
      environmentId?: string,
    ) => Promise<Record<string, unknown>>,
    base: string,
    addHome: () => Promise<string>,
    scan: () => Promise<void>,
  ) => Promise<void>,
  config: { prescan?: boolean; commitBetween?: boolean } = {},
) {
  const h = createHarness();
  const storage = new StorageService(path.join(h.dataDir, "storage"));
  try {
    await storage.init();
    const project = await storage.addProject(createProject("remote", h.repo));
    const base = git(h.repo, "rev-parse", "HEAD").trim();
    edit(h.repo);
    const environment = createEnvironment(project.id, { environmentType: "local" });
    Object.assign(environment, {
      id: "env-1",
      status: "running",
      setupPhase: "ready",
      worktreePath: h.repo,
      createdFromCommit: base,
      delegationBaseCommit: base,
      delegationBaseBranch: "main",
    });
    await storage.addEnvironment(environment);
    const scan = async () => {
      const detailed = await getLocalGitStatusDetailed(
        h.repo,
        base,
        true,
        createGitFetchScheduler(),
      );
      const now = new Date().toISOString();
      h.service.onDiffScanEvent({
        kind: "scanned",
        target: {
          environmentId: environment.id,
          comparisonRef: base,
          kind: "local",
          worktreePath: h.repo,
        },
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
    };
    if (config.prescan !== false) await scan();
    let committedBetween = false;
    const ensure = h.service.ensureResource.bind(h.service);
    const spy = spyOn(h.service, "ensureResource").mockImplementation(async (key) => {
      await ensure(key);
      if (config.commitBetween && key.includes("uncommitted-net") && !committedBetween) {
        committedBetween = true;
        git(h.repo, "add", ".");
        git(h.repo, "commit", "-qm", "commit between reads");
      }
    });
    const context = {
      storage,
      runtime: { changeTracking: h.service, diffStats: { service: { isTracked: () => true } } },
    } as unknown as CommandContext;
    const handler = createCommandRegistry().get("get_controller_worker_changes")!;
    await run(
      async (options, environmentId = environment.id) =>
        (await handler(
          { projectId: project.id, environmentId, ...(options ? { options } : {}) },
          context,
        )) as Record<string, unknown>,
      base,
      async () => {
        const home = createEnvironment(project.id, { environmentType: "local" });
        home.projectHome = true;
        await storage.addEnvironment(home);
        return home.id;
      },
      scan,
    );
    spy.mockRestore();
  } finally {
    storage.close();
    h.cleanup();
  }
}

test("a file changed in a commit and again uncommitted shows each side's lines apart", async () => {
  await withWorker(
    (repo) => {
      writeFileSync(path.join(repo, "a.txt"), "one\ncommitted line\n");
      writeFileSync(path.join(repo, "committed.txt"), "committed only\n");
      git(repo, "add", ".");
      git(repo, "commit", "-qm", "worker commit");
      writeFileSync(path.join(repo, "a.txt"), "one\ncommitted line\nuncommitted line\n");
    },
    async (read) => {
      const split = await read({ diffScope: "split" });
      expect(split).not.toHaveProperty("diffs");
      expect(split.committed).toMatchObject({
        available: true,
        files: expect.arrayContaining([
          expect.objectContaining({ path: "a.txt" }),
          expect.objectContaining({ path: "committed.txt" }),
        ]),
      });
      expect(split.sinceBase).toMatchObject({
        files: expect.arrayContaining([
          expect.objectContaining({ path: "a.txt", committed: true, uncommitted: true }),
          expect.objectContaining({ path: "committed.txt", committed: true, uncommitted: false }),
        ]),
      });
      const diffOf = (block: unknown, file: string) =>
        String(
          (
            (block as { files: Array<{ path: string; diff: string | null }> }).files.find(
              (entry) => entry.path === file,
            ) ?? { diff: null }
          ).diff,
        );
      const committedA = diffOf(split.committedDiffs, "a.txt");
      expect(committedA).toContain("+committed line");
      expect(committedA).not.toContain("uncommitted line");
      const uncommittedA = diffOf(split.uncommittedDiffs, "a.txt");
      expect(uncommittedA).toContain("+uncommitted line");
      expect(uncommittedA).not.toContain("+committed line");
      expect(diffOf(split.committedDiffs, "committed.txt")).toContain("+committed only");
      expect(diffOf(split.uncommittedDiffs, "committed.txt")).toBe("null");

      // Older callers: no diffScope is the combined base-to-working-tree diff.
      const combined = await read();
      expect(combined).not.toHaveProperty("committedDiffs");
      expect(combined).not.toHaveProperty("uncommittedDiffs");
      const combinedA = diffOf(combined.diffs, "a.txt");
      expect(combinedA).toContain("+committed line");
      expect(combinedA).toContain("+uncommitted line");

      const committedOnly = await read({ diffScope: "committed", paths: ["a.txt"] });
      expect(committedOnly).not.toHaveProperty("uncommittedDiffs");
      expect((committedOnly.committedDiffs as { files: unknown[] }).files).toEqual([
        expect.objectContaining({ path: "a.txt" }),
      ]);
    },
  );
});

test("controller changes read real baseline, commits, uncommitted files and diffs and reject project home", async () => {
  await withWorker(
    (repo) => {
      writeFileSync(path.join(repo, "committed.txt"), "committed change\n");
      git(repo, "add", ".");
      git(repo, "commit", "-qm", "worker commit");
      writeFileSync(path.join(repo, "a.txt"), "one\nuncommitted change\n");
      writeFileSync(path.join(repo, "untracked.txt"), "untracked change\n");
    },
    async (read, base, addHome) => {
      const result = await read();
      expect(result.base).toMatchObject({ commit: base });
      expect(result.commits).toMatchObject({
        items: [expect.objectContaining({ subject: "worker commit" })],
      });
      expect(result.sinceBase).toMatchObject({
        available: true,
        files: expect.arrayContaining([
          expect.objectContaining({ path: "committed.txt", uncommitted: false }),
          expect.objectContaining({ path: "a.txt", uncommitted: true }),
          expect.objectContaining({ path: "untracked.txt", uncommitted: true }),
        ]),
      });
      expect(result.uncommitted).toMatchObject({
        available: true,
        files: expect.arrayContaining([
          expect.objectContaining({ path: "a.txt" }),
          expect.objectContaining({ path: "untracked.txt" }),
        ]),
      });
      expect(JSON.stringify(result.diffs)).toContain("+uncommitted change");
      await expect(read(undefined, await addHome())).rejects.toThrow("project checkout");
    },
  );
});

test("split rejects scopes measured across a worker commit", async () => {
  await withWorker(
    (repo) => writeFileSync(path.join(repo, "a.txt"), "one\nnew edit\n"),
    async (read) => {
      const result = await read({ diffScope: "split" });
      expect(result).toHaveProperty("pending");
      expect(result.committed).toMatchObject({
        available: false,
        reason: "changes.reason.inconsistent-head",
      });
      expect(result.uncommittedDiffs).toMatchObject({ files: [] });
      expect(result.committedDiffs).toMatchObject({ files: [] });
    },
    { commitBetween: true },
  );
});

test("first read without a baseline is unavailable and omits committed flags, then recovers", async () => {
  await withWorker(
    (repo) => {
      writeFileSync(path.join(repo, "a.txt"), "one\ncommitted edit\n");
      git(repo, "commit", "-qam", "worker commit");
    },
    async (read, _base, _home, scan) => {
      const first = await read({ diffScope: "split" });
      expect(first.committed).toMatchObject({ available: false });
      expect(first).toHaveProperty("pending");
      expect(JSON.stringify(first.sinceBase)).not.toContain('"committed":false');
      await scan();
      const second = await read({ diffScope: "split" });
      expect(second.committed).toMatchObject({
        available: true,
        files: [expect.objectContaining({ path: "a.txt" })],
      });
    },
    { prescan: false },
  );
});
