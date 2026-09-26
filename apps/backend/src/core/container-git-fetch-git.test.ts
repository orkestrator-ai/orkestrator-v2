import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildContainerFetchScript,
  buildContainerGitStatusScript,
  getContainerGitStatusDetailed,
  type ContainerGitStatusDeps,
} from "./commands-files.js";
import {
  CONTAINER_FETCH_COOLDOWN_MS,
  ContainerGitFetchPolicy,
  type ContainerFetchChange,
} from "./container-git-fetch.js";
import { dockerExec } from "./commands-container-exec.js";
import { ManualTime } from "./recurring-test-support.js";
import { RecurringWorkMetrics } from "./recurring-work-metrics.js";

/**
 * The production status and fetch scripts against real Git, with no Docker:
 * a bare repository stands in for `origin`, a clone of it stands in for the
 * container's `/workspace`, and each "docker exec" is `bash -c <script>` in
 * that clone — the same program `dockerExec` hands to `bash -lc`. Nothing
 * here touches a real remote. Verifies actual ref movement, immutable commit
 * comparison, missing-ref recovery, offline behaviour and re-clone identity.
 */

type Row = { path: string; status: string };

let root: string;
let remote: string;
let seed: string;
let workspace: string;
let binDir: string;
let env: Record<string, string | undefined>;

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(
    ["git", "-c", "user.email=a@b", "-c", "user.name=a", "-c", "commit.gpgsign=false", ...args],
    { cwd, env },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

async function shell(cwd: string, script: string): Promise<string> {
  const child = Bun.spawn(["bash", "-c", script], { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`script exited ${code}: ${stderr}`);
  return stdout;
}

/** One "container": its clone, a fetch policy on a manual clock, the counted seams. */
function container(id = "container-git") {
  const time = new ManualTime(1_000_000);
  const fetchCalls: string[] = [];
  const changes: ContainerFetchChange[] = [];
  const policy = new ContainerGitFetchPolicy({
    now: time.now,
    metrics: new RecurringWorkMetrics({ now: time.now }),
    onChange: (change) => changes.push(change),
    runFetch: (_containerId, ref, timeoutMs) => {
      fetchCalls.push(ref);
      return shell(workspace, buildContainerFetchScript(ref, timeoutMs));
    },
  });
  const deps: ContainerGitStatusDeps = {
    exec: (_containerId, script) => shell(workspace, script),
    fetches: policy,
  };
  const read = async (ref: string) => {
    const result = await getContainerGitStatusDetailed(id, ref, true, deps);
    return {
      rows: (result.changes as Row[]).map(({ path: file, status }) => ({ path: file, status })),
      remote: result.remote,
    };
  };
  return { id, time, policy, fetchCalls, changes, read };
}

async function pushToRemote(file: string, contents: string, branch = "main"): Promise<string> {
  git(seed, "checkout", "-q", "-B", branch, `origin/main`);
  await fs.writeFile(path.join(seed, file), contents);
  git(seed, "add", file);
  git(seed, "commit", "-q", "-m", `add ${file}`);
  git(seed, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
  git(seed, "fetch", "-q", "origin");
  return git(seed, "rev-parse", "HEAD");
}

async function recloneWorkspace(): Promise<void> {
  await fs.rm(workspace, { recursive: true, force: true });
  git(root, "clone", "-q", remote, workspace);
  git(workspace, "checkout", "-q", "-b", "work");
  await fs.writeFile(path.join(workspace, "local.txt"), "local\n");
}

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ork-container-fetch-git-")));
  remote = path.join(root, "remote.git");
  seed = path.join(root, "seed");
  workspace = path.join(root, "workspace");
  binDir = path.join(root, "bin");
  await fs.mkdir(binDir);
  // `base64 -w0` is GNU; the container image has it, a macOS host may not.
  const realBase64 = (Bun.which("base64") ?? "base64").replaceAll("'", "'\\''");
  await fs.writeFile(
    path.join(binDir, "base64"),
    `#!/bin/sh
if printf '' | '${realBase64}' -w0 >/dev/null 2>&1; then exec '${realBase64}' "$@"; fi
if [ "$1" = "-w0" ]; then shift; fi
exec '${realBase64}' "$@"
`,
  );
  await fs.chmod(path.join(binDir, "base64"), 0o755);
  env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
  };
  await fs.writeFile(path.join(root, "gitconfig"), "");

  git(root, "init", "-q", "--bare", "-b", "main", remote);
  git(root, "clone", "-q", remote, seed);
  await fs.writeFile(path.join(seed, "base.txt"), "base\n");
  git(seed, "add", "base.txt");
  git(seed, "commit", "-q", "-m", "base");
  git(seed, "push", "-q", "origin", "HEAD:refs/heads/main");
  git(seed, "fetch", "-q", "origin");
});

beforeEach(async () => {
  await fs.rm(path.join(root, "remote-offline.git"), { recursive: true, force: true });
  await recloneWorkspace();
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("container status and fetch scripts against a local remote", () => {
  test("a branch baseline follows origin/<ref> only when the policy fetches", async () => {
    const box = container();
    const first = await box.read("main");
    expect(first.rows).toEqual([{ path: "local.txt", status: "?" }]);
    await box.policy.idle();
    expect(box.fetchCalls).toEqual(["main"]);
    expect(box.changes.at(-1)).toMatchObject({ baselineMoved: false });

    // The remote's main moves. Within the cooldown no read fetches, so the
    // comparison stays on the clone's (older) origin/main.
    await pushToRemote("upstream.txt", "upstream\n");
    for (let index = 0; index < 3; index += 1) {
      box.time.jump(5_000);
      expect((await box.read("main")).rows).toEqual([{ path: "local.txt", status: "?" }]);
    }
    await box.policy.idle();
    expect(box.fetchCalls).toEqual(["main"]);
    expect(box.policy.freshness(box.id, "main")).toMatchObject({ state: "current" });

    // A merge through the backend invalidates: the next read starts a fetch
    // that moves origin/main and asks for exactly one baseline rescan.
    box.policy.invalidate({ containerId: box.id }, "mutation");
    await box.read("main");
    await box.policy.idle();
    expect(box.fetchCalls).toEqual(["main", "main"]);
    expect(box.changes.at(-1)).toEqual({ containerId: box.id, ref: "main", baselineMoved: true });
    const moved = await box.read("main");
    // The work branch lacks the new upstream file: the diff is now against it.
    expect(moved.rows).toContainEqual({ path: "upstream.txt", status: "D" });
    expect(moved.remote).toMatchObject({ state: "current" });

    // After the cooldown the next read fetches again on its own.
    box.time.jump(CONTAINER_FETCH_COOLDOWN_MS);
    await box.read("main");
    await box.policy.idle();
    expect(box.fetchCalls).toHaveLength(3);
  });

  test("an immutable creation commit is compared exactly and never fetched", async () => {
    const box = container();
    // The environment's recorded creation commit.
    const creationCommit = git(workspace, "rev-parse", "HEAD");
    await pushToRemote("later.txt", "later\n");
    git(workspace, "fetch", "-q", "origin");
    // The moved default branch would show the newer upstream file.
    expect((await box.read("main")).rows).toContainEqual({ path: "later.txt", status: "D" });
    await box.policy.idle();
    box.fetchCalls.length = 0;

    for (let index = 0; index < 3; index += 1) {
      const result = await box.read(creationCommit);
      // Exactly the recorded commit, not the (moved) default branch.
      expect(result.rows).toEqual([{ path: "local.txt", status: "?" }]);
      expect(result.remote).toEqual({ state: "not-required" });
      box.time.jump(CONTAINER_FETCH_COOLDOWN_MS);
    }
    await box.policy.idle();
    expect(box.fetchCalls).toEqual([]);
  });

  test("a ref missing locally is recovered by one bounded fetch", async () => {
    const box = container();
    await pushToRemote("feature.txt", "feature\n", "feature-x");
    // The clone predates the branch: the status script reports it missing,
    // the wrapper fetches once and re-resolves.
    const recovered = await box.read("feature-x");
    expect(box.fetchCalls).toEqual(["feature-x"]);
    expect(recovered.rows).toContainEqual({ path: "local.txt", status: "?" });
    expect(recovered.rows).toContainEqual({ path: "feature.txt", status: "D" });
    await box.policy.idle();
    expect(box.fetchCalls).toEqual(["feature-x"]);

    // Absent everywhere: the existing missing-target error, never an empty
    // diff, and later reads in the window do not fetch again.
    await expect(box.read("nowhere")).rejects.toThrow(
      "Target ref is not present in the container: nowhere",
    );
    await expect(box.read("nowhere")).rejects.toThrow("Target ref is not present");
    expect(box.fetchCalls).toEqual(["feature-x", "nowhere"]);
  });

  test("an unreachable remote keeps the local diff with stale remote freshness", async () => {
    const box = container();
    await box.read("main");
    await box.policy.idle();
    const good = box.policy.freshness(box.id, "main");
    expect(good).toMatchObject({ state: "current" });

    await fs.rename(remote, path.join(root, "remote-offline.git"));
    try {
      box.time.jump(CONTAINER_FETCH_COOLDOWN_MS);
      const offline = await box.read("main");
      expect(offline.rows).toEqual([{ path: "local.txt", status: "?" }]);
      await box.policy.idle();
      expect(box.fetchCalls).toHaveLength(2);
      const stale = box.policy.freshness(box.id, "main");
      expect(stale).toMatchObject({ state: "stale", lastSuccessAt: good!.lastSuccessAt });
      expect(stale?.failure).toBeDefined();
      // Still answering locally; no retry inside the failure cooldown.
      box.time.jump(60_000);
      expect((await box.read("main")).rows).toEqual([{ path: "local.txt", status: "?" }]);
      await box.policy.idle();
      expect(box.fetchCalls).toHaveLength(2);
    } finally {
      await fs.rename(path.join(root, "remote-offline.git"), remote);
    }
  });

  test("a workspace re-cloned inside the same container is a new clone identity", async () => {
    const box = container();
    await box.read("main");
    await box.policy.idle();
    expect(box.fetchCalls).toHaveLength(1);
    await box.read("main");
    await box.policy.idle();
    expect(box.fetchCalls).toHaveLength(1);

    await recloneWorkspace();
    await box.read("main");
    await box.policy.idle();
    expect(box.fetchCalls).toHaveLength(2);
  });

  test("the status script performs no fetch of its own", () => {
    const script = buildContainerGitStatusScript("main", true);
    expect(script).not.toContain("git fetch");
    expect(buildContainerFetchScript("main", 30_000)).toContain('git fetch origin "$ref"');
  });
});

const dockerTest = process.env.ORKESTRATOR_TEST_DOCKER_IMAGE ? test : test.skip;
dockerTest("a real container recovers a missing tracking ref and rescans status", async () => {
  const image = process.env.ORKESTRATOR_TEST_DOCKER_IMAGE!;
  await fs.writeFile(path.join(root, "docker-gitconfig"), "[safe]\n\tdirectory = *\n");
  const started = Bun.spawnSync([
    "docker",
    "run",
    "--rm",
    "--detach",
    "--network",
    "none",
    "--user",
    `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    "--mount",
    `type=bind,source=${root},target=/fixture`,
    "--mount",
    `type=bind,source=${workspace},target=/workspace`,
    "--env",
    "GIT_CONFIG_GLOBAL=/fixture/docker-gitconfig",
    "--env",
    "GIT_TERMINAL_PROMPT=0",
    "--env",
    "GIT_ASKPASS=/bin/false",
    "--entrypoint",
    "/bin/sleep",
    image,
    "infinity",
  ]);
  if (started.exitCode !== 0) throw new Error(started.stderr.toString());
  const containerId = started.stdout.toString().trim();
  try {
    await dockerExec(containerId, "git remote set-url origin /fixture/remote.git");
    expect((await dockerExec(containerId, "printf '%s' \"$GIT_CONFIG_GLOBAL\"")).trim()).toBe(
      "/fixture/docker-gitconfig",
    );
    await pushToRemote("remote-only.txt", "remote\n", "live-recovery-branch");
    const policy = new ContainerGitFetchPolicy({
      metrics: new RecurringWorkMetrics(),
      runFetch: (id, ref, timeoutMs) => dockerExec(id, buildContainerFetchScript(ref, timeoutMs)),
    });
    const result = await getContainerGitStatusDetailed(containerId, "live-recovery-branch", true, {
      exec: (id, script) => dockerExec(id, script),
      fetches: policy,
    });
    expect(result.changes.map(({ path: file, status }) => ({ path: file, status }))).toContainEqual(
      {
        path: "remote-only.txt",
        status: "D",
      },
    );
    expect(result.remote?.state).toBe("current");
    await policy.idle();
  } finally {
    Bun.spawnSync(["docker", "rm", "--force", containerId]);
  }
});
