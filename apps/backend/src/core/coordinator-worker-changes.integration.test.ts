import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { createHarness, git } from "./change-tracking/service-test-support.js";
import { createGitFetchScheduler } from "./diff-stats-tracking.js";
import { getLocalGitStatusDetailed } from "./commands-files.js";
import type { CommandContext } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";
import { createEnvironment, createProject, StorageService } from "./storage.js";

test("controller changes read real baseline, commits, uncommitted files and diffs and reject project home", async () => {
  const h = createHarness();
  const storage = new StorageService(path.join(h.dataDir, "storage"));
  try {
    await storage.init();
    const project = await storage.addProject(createProject("remote", h.repo));
    const base = git(h.repo, "rev-parse", "HEAD").trim();
    writeFileSync(path.join(h.repo, "committed.txt"), "committed change\n");
    git(h.repo, "add", ".");
    git(h.repo, "commit", "-qm", "worker commit");
    writeFileSync(path.join(h.repo, "a.txt"), "one\nuncommitted change\n");
    writeFileSync(path.join(h.repo, "untracked.txt"), "untracked change\n");
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
    const detailed = await getLocalGitStatusDetailed(h.repo, base, true, createGitFetchScheduler());
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
    const context = {
      storage,
      runtime: { changeTracking: h.service, diffStats: { service: { isTracked: () => true } } },
    } as unknown as CommandContext;
    const handler = createCommandRegistry().get("get_controller_worker_changes")!;
    const args = { projectId: project.id, environmentId: environment.id };
    const result = (await handler(args, context)) as Record<string, unknown>;
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
    const home = createEnvironment(project.id, { environmentType: "local" });
    home.projectHome = true;
    await storage.addEnvironment(home);
    await expect(handler({ ...args, environmentId: home.id }, context)).rejects.toThrow(
      "project checkout",
    );
  } finally {
    storage.close();
    h.cleanup();
  }
});
