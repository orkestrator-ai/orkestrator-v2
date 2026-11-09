/**
 * A project's Git mirror in real containers: the real entrypoint and this
 * checkout's `workspace-setup.sh`, bound over the image's copy so the test
 * follows the branch, with the mirror the backend really built on the mount it
 * really uses. `--network none`: the remote is a bare repository bound at the
 * agent-test path and reached by `file://`, so no address pool is touched.
 */
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitForContainerBoot } from "../src/core/container-readiness";
import {
  gitMirrorContainerArguments,
  refreshProjectGitMirror,
  removeProjectGitMirror,
  sweepOrphanedProjectGitMirrors,
} from "../src/core/project-git-mirror";
import { runCommand } from "../src/core/shell";

const image = process.env.ORKESTRATOR_QUALIFICATION_IMAGE?.trim();
const enabled = process.env.RUN_LIVE_DOCKER_TESTS === "1" && Boolean(image);
const setupScript = path.join(import.meta.dir, "..", "..", "..", "docker", "workspace-setup.sh");
const REMOTE_PATH = "/orkestrator-agent-test-origin.git";
const PROJECT_ID = "project-live";

const docker = async (args: string[]) =>
  (await runCommand("docker", args, { timeoutMs: 180_000 })).stdout.trim();

const containers: string[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const container of containers.splice(0)) {
    await docker(["rm", "-f", container]).catch(() => undefined);
  }
  for (const root of roots.splice(0)) {
    // A source Docker recreated belongs to root; only an empty one can be left.
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-git-mirror-live-"));
  roots.push(root);
  const remote = path.join(root, "remote.git");
  const work = path.join(root, "work");
  git(root, ["init", "-q", "--bare", "--initial-branch=main", remote]);
  git(root, ["clone", "-q", remote, work]);
  git(work, ["checkout", "-qb", "main"]);
  git(work, ["config", "user.name", "T"]);
  git(work, ["config", "user.email", "t@example.com"]);
  for (const name of ["one", "two"]) {
    await fs.writeFile(path.join(work, `${name}.txt`), `${name}\n`);
    git(work, ["add", "."]);
    git(work, ["commit", "-qm", `change ${name}`]);
  }
  git(work, ["push", "-q", "origin", "main"]);
  const dataDir = path.join(root, "data");
  const context = {
    storage: { getDataDir: () => dataDir, loadConfig: async () => ({ global: {} }) },
  };
  const project = { id: PROJECT_ID, gitUrl: `file://${remote}` };
  const mount = path.join(dataDir, "git-mirrors", PROJECT_ID, "mount-anonymous");
  return {
    root,
    remote,
    dataDir,
    mount,
    build: () =>
      refreshProjectGitMirror(
        context as never,
        project,
        { kind: "anonymous", localRemote: true },
        { force: true },
      ),
  };
}

async function environmentContainer(
  setup: Awaited<ReturnType<typeof fixture>>,
  options: { mirror?: boolean } = {},
) {
  const mirrorArgs =
    options.mirror === false
      ? []
      : await gitMirrorContainerArguments(setup.dataDir, { id: PROJECT_ID }, "anonymous");
  const container = await docker([
    "create",
    "--label",
    `orkestrator-qualification=git-mirror-${crypto.randomUUID()}`,
    "--network",
    "none",
    "-e",
    "NETWORK_MODE=full",
    "-e",
    `GIT_URL=file://${REMOTE_PATH}`,
    "-e",
    "GIT_BRANCH=main",
    "-e",
    `ORKESTRATOR_AGENT_TEST_GIT_REMOTE=${REMOTE_PATH}`,
    "-v",
    `${setup.remote}:${REMOTE_PATH}`,
    "--mount",
    `type=bind,src=${setupScript},dst=/usr/local/bin/workspace-setup.sh,readonly`,
    ...mirrorArgs,
    image!,
  ]);
  containers.push(container);
  await docker(["start", container]);
  await waitForContainerBoot(container);
  const inContainer = (...args: string[]) => docker(["exec", "--user", "node", container, ...args]);
  // Logs each pack the remote has to build. Global config, which is the only
  // place `upload-pack` honours this hook from, in the real user's home.
  await docker([
    "exec",
    "--user",
    "node",
    container,
    "bash",
    "-c",
    `printf '#!/bin/sh\\necho sent >> /tmp/pack-objects.log\\nexec "$@"\\n' > /tmp/pack-hook && chmod +x /tmp/pack-hook && git config --global uploadpack.packObjectsHook /tmp/pack-hook && git config --global uploadpack.allowFilter true`,
  ]);
  const prepare = () =>
    inContainer("bash", "-c", "/usr/local/bin/workspace-setup.sh --prepare-only");
  const remoteSentObjects = async () =>
    (await inContainer("bash", "-c", "test -s /tmp/pack-objects.log && echo yes || echo no")) ===
    "yes";
  return { container, inContainer, prepare, remoteSentObjects };
}

test.skipIf(!enabled)(
  "first environment falls back, second clones from the mirror, the mount is read-only and the clone outlives it",
  async () => {
    const setup = await fixture();

    // First environment of a project: nothing is published yet.
    const first = await environmentContainer(setup);
    const firstOutput = await first.prepare();
    expect(firstOutput).toContain("ORKESTRATOR_GIT_MIRROR:missing");
    expect(firstOutput).toContain("Git mirror not used (missing); cloning from the remote.");
    expect(await first.remoteSentObjects()).toBe(true);
    expect(await first.inContainer("git", "-C", "/workspace", "log", "-1", "--format=%s")).toBe(
      "change two",
    );

    // Second environment: published by the backend, visible through the same mount.
    expect(await setup.build()).toBe("built");
    const second = await environmentContainer(setup);
    const secondOutput = await second.prepare();
    expect(secondOutput).toContain("ORKESTRATOR_GIT_MIRROR:used");
    expect(await second.remoteSentObjects()).toBe(false);
    expect(await second.inContainer("git", "-C", "/workspace", "remote", "get-url", "origin")).toBe(
      `file://${REMOTE_PATH}`,
    );

    // A write from inside fails, for root too: the kernel's read-only bind.
    // The kernel checks file permissions before the mount's read-only flag, so
    // `node` reaches that flag only when it owns the mirror: when the backend's
    // host user is uid 1000. Otherwise (GitHub's runners, a rootless daemon) it
    // is refused by permission first. Root bypasses permissions either way, so
    // it always proves the bind itself is read-only.
    const nodeOwnsMirror =
      (await second.inContainer(
        "sh",
        "-c",
        "test -O /orkestrator-git-mirror/mirror.git/config && echo owner || echo other",
      )) === "owner";
    const expectedWriteError = {
      node: nodeOwnsMirror ? "Read-only file system" : "Permission denied",
      root: "Read-only file system",
    };
    for (const user of ["node", "root"] as const) {
      const write = spawnSync(
        "docker",
        [
          "exec",
          "--user",
          user,
          second.container,
          "sh",
          "-c",
          "touch /orkestrator-git-mirror/mirror.git/config || exit 42; echo wrote",
        ],
        { encoding: "utf8" },
      );
      expect(write.status).toBe(42);
      expect(write.stderr).toContain(expectedWriteError[user]);
    }
    const mounts = await docker([
      "inspect",
      "--format",
      '{{range .Mounts}}{{if eq .Destination "/orkestrator-git-mirror"}}{{.RW}}{{end}}{{end}}',
      second.container,
    ]);
    expect(mounts).toBe("false");

    // Self-contained: the mirror goes away, then the whole bind source.
    await fs.rm(path.join(setup.mount, "mirror.git"), { recursive: true, force: true });
    const inWorkspace = (...args: string[]) =>
      second.inContainer("git", "-C", "/workspace", ...args);
    expect(await inWorkspace("status", "--porcelain")).toBe("");
    expect(await inWorkspace("log", "--format=%s")).toBe("change two\nchange one");
    expect(await inWorkspace("diff", "HEAD~1", "HEAD", "--name-only")).toBe("two.txt");
    await inWorkspace("fsck", "--full");

    // A stopped environment must still start with its mount's source gone.
    await docker(["stop", "--time", "2", second.container]);
    await fs.rm(setup.mount, { recursive: true, force: true });
    await docker(["start", second.container]);
    await waitForContainerBoot(second.container);
    expect(await inWorkspace("status", "--porcelain")).toBe("");

    // Docker recreated the source, as root on a rootful daemon: the next
    // creation takes it back, and the project gets its mirror again.
    expect(
      await gitMirrorContainerArguments(setup.dataDir, { id: PROJECT_ID }, "anonymous"),
    ).not.toEqual([]);
    expect(await setup.build()).toBe("built");
    const third = await environmentContainer(setup);
    expect(await third.prepare()).toContain("ORKESTRATOR_GIT_MIRROR:used");

    // Deleting the whole parent differs from deleting mount/: rootful Docker
    // creates both as root. Do not silently promise an unprivileged repair.
    await docker(["stop", "--time", "2", third.container]);
    const projectDirectory = path.dirname(setup.mount);
    await fs.rm(projectDirectory, { recursive: true, force: true });
    await docker(["start", third.container]);
    await waitForContainerBoot(third.container);
    expect(await third.inContainer("git", "-C", "/workspace", "status", "--porcelain")).toBe("");
    const foreignOwner = (await fs.stat(projectDirectory)).uid !== process.getuid!();
    if (foreignOwner) {
      const { captureLogs } = await import("@orkestrator/protocol/testing/log-capture");
      const logs = captureLogs();
      try {
        expect(
          await gitMirrorContainerArguments(setup.dataDir, { id: PROJECT_ID }, "anonymous"),
        ).toEqual([]);
        expect(await setup.build()).toBe("failed");
        for (const event of ["git-mirror.mount-unavailable", "git-mirror.refresh-failed"]) {
          expect(
            logs.records().find((record) => record.event === event)?.fields?.remediation,
          ).toContain("Restore backend-user ownership");
        }
      } finally {
        logs.restore();
      }
      const fallback = await environmentContainer(setup);
      await fallback.prepare();
      expect(await fallback.remoteSentObjects()).toBe(true);
      await removeProjectGitMirror(
        { storage: { getDataDir: () => setup.dataDir } } as never,
        PROJECT_ID,
      );
      expect(await sweepOrphanedProjectGitMirrors(setup.dataDir, new Set(), 0)).toBe(0);
      expect(await fs.stat(projectDirectory)).toBeDefined();

      // Model the documented host operator repair, confined to this test's
      // exact disposable project tree. Production never invokes this helper.
      await docker([
        "run",
        "--rm",
        "--network",
        "none",
        "--user",
        "0",
        "--entrypoint",
        "chown",
        "-v",
        `${projectDirectory}:/repair`,
        image!,
        "-R",
        `${process.getuid!()}:${process.getgid!()}`,
        "/repair",
      ]);
      await fs.chmod(projectDirectory, 0o700);
    }
    expect(
      await gitMirrorContainerArguments(setup.dataDir, { id: PROJECT_ID }, "anonymous"),
    ).not.toEqual([]);
    expect(await setup.build()).toBe("built");
    expect(await sweepOrphanedProjectGitMirrors(setup.dataDir, new Set(), 0)).toBe(1);
  },
  300_000,
);

test.skipIf(!enabled)(
  "a corrupt mirror falls back to the ordinary clone with the reason in the output",
  async () => {
    const setup = await fixture();
    expect(await setup.build()).toBe("built");
    await fs.writeFile(path.join(setup.mount, "mirror.git", "HEAD"), "garbage\n");
    await fs.rm(path.join(setup.mount, "mirror.git", "objects"), { recursive: true });
    await fs.mkdir(path.join(setup.mount, "mirror.git", "objects"));

    const environment = await environmentContainer(setup);
    const output = await environment.prepare();

    expect(output).toContain("ORKESTRATOR_GIT_MIRROR:corrupt");
    expect(output).toContain("Git mirror not used (corrupt); cloning from the remote.");
    expect(await environment.remoteSentObjects()).toBe(true);
    expect(
      await environment.inContainer("git", "-C", "/workspace", "log", "-1", "--format=%s"),
    ).toBe("change two");
  },
  300_000,
);

test.skipIf(!enabled)(
  "a workload user that does not own the mirror can still clone from it, as under rootless Docker",
  async () => {
    const setup = await fixture();
    expect(await setup.build()).toBe("built");
    const id = await docker([
      "create",
      "--label",
      `orkestrator-qualification=git-mirror-${crypto.randomUUID()}`,
      "--network",
      "none",
      "--user",
      "12345:12345",
      "--env",
      "HOME=/tmp/foreign-home",
      "--entrypoint",
      "bash",
      "-v",
      `${setup.mount}:/orkestrator-git-mirror:ro`,
      "-v",
      `${setup.remote}:${REMOTE_PATH}:ro`,
      image!,
      "-c",
      `mkdir -p "$HOME" && git config --global --add safe.directory ${REMOTE_PATH} &&
       git clone -q --no-tags --reference-if-able /orkestrator-git-mirror/mirror.git --dissociate file://${REMOTE_PATH} /tmp/clone &&
       test ! -e /tmp/clone/.git/objects/info/alternates &&
       git -C /tmp/clone log -1 --format=%s`,
    ]);
    containers.push(id);
    expect((await docker(["start", "--attach", id])).trim()).toBe("change two");
  },
  300_000,
);

test.skipIf(!enabled)(
  "a runtime with no mirror, as from an older image, clones exactly as before",
  async () => {
    const setup = await fixture();
    const environment = await environmentContainer(setup, { mirror: false });

    const output = await environment.prepare();

    expect(output).not.toContain("ORKESTRATOR_GIT_MIRROR");
    expect(
      await environment.inContainer("git", "-C", "/workspace", "config", "remote.origin.promisor"),
    ).toBe("true");
  },
  300_000,
);
