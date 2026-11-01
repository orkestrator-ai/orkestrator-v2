import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { configureLogger } from "@orkestrator/protocol/logger";
import { captureLogs, type LogCapture } from "@orkestrator/protocol/testing/log-capture";
import { renameLiveGitBranch } from "./commands-agent-support.js";
import type { Environment } from "./models.js";

const posixOnly = process.platform === "win32" ? describe.skip : describe;

function environment(fields: Partial<Environment>): Environment {
  return { id: "env-1", status: "running", ...fields } as Environment;
}

posixOnly("failed branch renames log a reason, not the command's output", () => {
  let root: string;
  let worktree: string;
  let capture: LogCapture;
  const originalPath = process.env.PATH;

  function git(...args: string[]): void {
    execFileSync("git", ["-C", worktree, ...args], { stdio: "pipe" });
  }

  /** A `docker` on PATH that answers each call from a script, as the real one would. */
  function fakeDocker(script: string): void {
    const file = path.join(root, "docker");
    writeFileSync(file, `#!/bin/sh\n${script}\n`);
    chmodSync(file, 0o755);
    process.env.PATH = `${root}:${originalPath}`;
  }

  beforeAll(() => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ork-branch-rename-")));
    worktree = path.join(root, "worktree");
    execFileSync("git", ["init", "-q", "-b", "old-branch", worktree], { stdio: "pipe" });
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "c");
    git("branch", "taken-branch");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    capture = captureLogs();
  });

  afterEach(() => {
    capture.restore();
    process.env.PATH = originalPath;
  });

  test("a local rename onto a taken name reports branch-exists", async () => {
    const renamed = await renameLiveGitBranch(
      environment({ worktreePath: worktree }),
      "old-branch",
      "taken-branch",
    );
    expect(renamed).toBe(false);
    const [record] = capture.records();
    expect(capture.records()).toHaveLength(1);
    expect(record).toMatchObject({
      level: "warn",
      area: "git",
      event: "branch.rename-failed",
      fields: {
        reason: "branch-exists",
        exitCode: 128,
        signal: null,
        environmentId: "env-1",
        runtime: "local",
        error: { name: "CommandFailedError", outputOmitted: true, exitCode: 128 },
      },
    });
    const line = capture.lines.join("\n");
    expect(line).toContain("[git] branch.rename-failed reason=branch-exists exitCode=128");
    // The branch name and git's own words are what the old line printed.
    expect(line).not.toContain("taken-branch");
    expect(line).not.toContain("fatal:");
    expect(line).not.toContain(root);
  });

  test("a container rename reads docker's failure and reports it", async () => {
    fakeDocker(`echo "Error response from daemon: No such container: abc" >&2\nexit 1`);
    const renamed = await renameLiveGitBranch(
      environment({ containerId: "abc" }),
      "old-branch",
      "new-branch",
    );
    expect(renamed).toBe(false);
    expect(capture.records()[0]).toMatchObject({
      event: "branch.rename-failed",
      fields: { reason: "container-not-found", exitCode: 1, runtime: "container" },
    });
    expect(capture.lines.join("\n")).not.toContain("daemon");
  });

  test("a container rename reads git's failure through the exec", async () => {
    fakeDocker(`echo "fatal: a branch named 'new-branch' already exists" >&2\nexit 128`);
    await renameLiveGitBranch(environment({ containerId: "abc" }), "old-branch", "new-branch");
    expect(capture.records()[0]).toMatchObject({
      fields: { reason: "branch-exists", exitCode: 128, runtime: "container" },
    });
    expect(capture.lines.join("\n")).not.toContain("new-branch");
  });

  test("a push-config failure and a failed rollback each get their own event", async () => {
    // Fails the push configuration, then the rollback, then answers the ref probes.
    const count = path.join(root, "docker-count");
    writeFileSync(count, "");
    fakeDocker(`echo x >> "${count}"
case "$(wc -l < "${count}" | tr -d ' ')" in
  1) exit 0 ;;
  2) echo "error: could not lock config file: Permission denied" >&2; exit 255 ;;
  3) echo "fatal: Unable to create '/workspace/.git/index.lock': File exists." >&2; exit 128 ;;
  *) exit 0 ;;
esac`);
    const renamed = await renameLiveGitBranch(
      environment({ containerId: "abc" }),
      "old-branch",
      "new-branch",
    );
    expect(renamed).toBe(false);
    expect(
      capture
        .records()
        .map(({ event, fields }) => [event, fields?.reason, fields?.exitCode, fields?.runtime]),
    ).toEqual([
      ["branch.push-config-failed", "permission-denied", 255, "container"],
      ["branch.rollback-failed", "lock-held", 128, "container"],
    ]);
  });

  test("building the entry is skipped when the level is off", async () => {
    configureLogger({ level: "error" });
    await renameLiveGitBranch(
      environment({ worktreePath: worktree }),
      "old-branch",
      "taken-branch",
    );
    expect(capture.records()).toEqual([]);
  });
});
