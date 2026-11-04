import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkUpstreamBeforeMessage } from "./coordinator-message-upstream.js";
import { ProjectGitService } from "./project-git-service.js";
import { runCommand } from "./shell.js";
import { createProject, StorageService } from "./storage.js";

// Real repositories and a fetch held open on purpose: slow tier by name.
setDefaultTimeout(30_000);

describe("fast-forwarding to the upstream already fetched", () => {
  let root: string;
  let checkout: string;
  let storage: StorageService;
  let projectId: string;
  let tip: string;
  let release: string;

  const git = (args: string[], cwd = checkout) =>
    runCommand("git", args, { cwd, timeoutMs: 20_000 }).then((result) => result.stdout.trim());

  async function commit(cwd: string, file: string): Promise<void> {
    await fs.writeFile(path.join(cwd, file), `${file}\n`);
    await git(["add", file], cwd);
    await git(["commit", "-q", "-m", file], cwd);
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-fetched-ff-"));
    checkout = path.join(root, "checkout");
    const remote = path.join(root, "remote.git");
    const publisher = path.join(root, "publisher");
    await fs.mkdir(checkout);
    await git(["init", "-q", "-b", "main"]);
    for (const cwd of [checkout]) {
      await git(["config", "user.email", "test@example.invalid"], cwd);
      await git(["config", "user.name", "Test"], cwd);
    }
    await commit(checkout, "README.md");
    await git(["clone", "-q", "--bare", checkout, remote], root);
    await git(["remote", "add", "origin", remote]);
    await git(["fetch", "-q", "origin"]);
    await git(["branch", "-q", "--set-upstream-to", "origin/main", "main"]);
    // Two commits land upstream and are fetched, as in the incident: the
    // checkout is behind refs it already has.
    await git(["clone", "-q", remote, publisher], root);
    await git(["config", "user.email", "publisher@example.invalid"], publisher);
    await git(["config", "user.name", "Publisher"], publisher);
    await commit(publisher, "one.txt");
    await commit(publisher, "two.txt");
    await git(["push", "-q"], publisher);
    await git(["fetch", "-q", "origin"]);
    tip = await git(["rev-parse", "origin/main"]);
    // From here the remote hangs until the test releases it: a stand-in for an
    // SSH login that takes tens of seconds.
    release = path.join(root, "release");
    const ssh = path.join(root, "slow-ssh.sh");
    await fs.writeFile(
      ssh,
      `#!/bin/sh\nwhile [ ! -e '${release}' ]; do sleep 0.05; done\nexit 1\n`,
      { mode: 0o755 },
    );
    await git(["config", "core.sshCommand", ssh]);
    await git(["config", "ssh.variant", "simple"]);
    await git(["remote", "set-url", "origin", "ssh://git@slow.invalid/repo.git"]);

    storage = new StorageService(path.join(root, "data"));
    await storage.init();
    projectId = (await storage.addProject(createProject(remote, checkout))).id;
  });

  afterEach(async () => {
    await fs.writeFile(release, "");
    storage.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  test("a typed message's check fast-forwards locally while the fetch hangs", async () => {
    const service = new ProjectGitService(storage);
    const before = await git(["rev-parse", "HEAD"]);
    // The slow fetch is already running and holds the checkout's Git queue.
    const late = service.fetch(projectId, true);
    let lateSettled = false;
    void late.finally(() => {
      lateSettled = true;
    });
    const check = await checkUpstreamBeforeMessage(service, projectId, { timeoutMs: 50 });
    // Answered past the bound, not by a fetch that failed fast.
    expect(lateSettled).toBe(false);
    expect(check).toMatchObject({
      offer: false,
      reason: "fast-forwarded",
      status: { headCommit: tip, behind: 0, ahead: 0 },
    });
    expect(await git(["rev-parse", "HEAD"])).toBe(tip);

    // The late fetch ends (here it fails) and merges nothing a second time.
    await fs.writeFile(release, "");
    expect((await late).remoteState).toBe("stale");
    expect(await git(["rev-parse", "HEAD"])).toBe(tip);
    expect(await git(["rev-list", "--count", `${before}..HEAD`])).toBe("2");
    expect((await git(["reflog", "--format=%gs", "-n", "5"])).split("\n")[0]).toMatch(
      /^merge [0-9a-f]+: Fast-forward$/,
    );
  });

  test("turn admission waits for the local fast-forward", async () => {
    const service = new ProjectGitService(storage);
    const merging = service.fastForwardToFetchedUpstream(projectId);
    const admitted = await service.beginTurnAfterMergeSync(projectId);
    expect(await git(["rev-parse", "HEAD"])).toBe(tip);
    admitted();
    expect((await merging).outcome).toBe("fast-forwarded");
  });

  test("leaves an uncommitted, diverged or busy checkout alone", async () => {
    const service = new ProjectGitService(storage);
    const head = await git(["rev-parse", "HEAD"]);

    await fs.writeFile(path.join(checkout, "notes.txt"), "draft\n");
    expect(await checkUpstreamBeforeMessage(service, projectId, { timeoutMs: 50 })).toMatchObject({
      offer: false,
      reason: "blocked",
    });
    expect(await git(["rev-parse", "HEAD"])).toBe(head);
    // Let the check's late fetch end before the checkout changes under it.
    await fs.writeFile(release, "");
    await service.fetch(projectId);

    await git(["add", "notes.txt"]);
    await git(["commit", "-q", "-m", "local"]);
    const local = await git(["rev-parse", "HEAD"]);
    expect((await service.fastForwardToFetchedUpstream(projectId)).outcome).toBe("blocked");
    expect(await git(["rev-parse", "HEAD"])).toBe(local);

    await git(["reset", "-q", "--hard", head]);
    const running = new ProjectGitService(storage, async () => true);
    expect(await running.fastForwardToFetchedUpstream(projectId)).toEqual({
      outcome: "busy",
      status: null,
    });
    expect(await checkUpstreamBeforeMessage(running, projectId, { timeoutMs: 50 })).toEqual({
      offer: false,
      reason: "turn-running",
      status: null,
    });
    expect(await git(["rev-parse", "HEAD"])).toBe(head);
  });
});
