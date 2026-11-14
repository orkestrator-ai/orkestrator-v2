/**
 * The host side of a project's Git mirror, with real Git against real local
 * repositories: how it is built, refreshed, bounded and removed, and what access
 * each mirror is fetched with. The container side is
 * `tests/unit/workspace-setup-git-mirror.test.ts`, and the mount is
 * `project-git-mirror-docker.test.ts`.
 *
 * A mirror fetch ignores the host's Git configuration, so the local `file://`
 * remotes here are fetched as the agent-test fixture is (`localRemote`), and a
 * test that needs a host-only URL rewrites the fetch's own arguments.
 *
 * Fixture and helpers shared by the `project-git-mirror-*.integration.test.ts` parts.
 * Each part runs in its own process under `bun test --parallel`, so the `let` bindings
 * below are private to the part that registers the fixture.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs, existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CommandContext } from "../src/core/commands-context";
import {
  refreshProjectGitMirror,
  type GitMirrorRefreshOptions,
} from "../src/core/project-git-mirror";
import type { GitMirrorAccess } from "../src/core/project-git-mirror-access";
import { runCommand } from "../src/core/shell";
import { StorageService } from "../src/core/storage";

export const setupScript = path.join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "docker",
  "workspace-setup.sh",
);

export const PROJECT_ID = "project-1";

export let root: string;

export let dataDir: string;

export let remote: string;

export let work: string;

export let storage: StorageService;

export let context: Pick<CommandContext, "storage">;

export const savedEnv = { ...process.env };

export function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

export function commit(name: string, content: string): void {
  writeFileSync(path.join(work, name), content);
  git(work, ["add", "."]);
  git(work, ["commit", "-qm", `change ${name}`]);
  git(work, ["push", "-q", "origin", "main"]);
}

export const project = () => ({ id: PROJECT_ID, gitUrl: `file://${remote}` });

export const projectDir = () => path.join(dataDir, "git-mirrors", PROJECT_ID);

/** What a container bound to the agent-test fixture holds: no credential, `file` only. */
export const LOCAL: GitMirrorAccess = { kind: "anonymous", localRemote: true };

export const mountPath = (kind: string = LOCAL.kind) => path.join(projectDir(), `mount-${kind}`);

export const mirrorPath = (kind?: string) => path.join(mountPath(kind), "mirror.git");

export const refresh = (
  options: GitMirrorRefreshOptions = {},
  target = project(),
  access: GitMirrorAccess = LOCAL,
) =>
  refreshProjectGitMirror(context, target, access, {
    force: true,
    accountLogin: async () => "alice",
    ...options,
  });

export const readState = async () =>
  JSON.parse(await fs.readFile(path.join(projectDir(), "state.json"), "utf8")) as Record<
    string,
    unknown
  >;

export const mirrorRefs = () =>
  git(root, [`--git-dir=${mirrorPath()}`, "for-each-ref", "--format=%(refname)"]).split("\n");

/** Every file in the mirror that is not an object: anything Git could have written a URL to. */
export async function nonObjectFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "objects") files.push(...(await nonObjectFiles(target)));
    } else {
      files.push(target);
    }
  }
  return files;
}

export const seeded = (localPath: string | null = work) => ({ ...project(), localPath });

export const remoteTip = (branch = "main") => git(remote, ["rev-parse", `refs/heads/${branch}`]);

export const allObjects = () =>
  git(root, [
    `--git-dir=${mirrorPath()}`,
    "cat-file",
    "--batch-all-objects",
    "--batch-check=%(objectname)",
  ])
    .split("\n")
    .sort();

export const reachableObjects = () =>
  git(root, [`--git-dir=${mirrorPath()}`, "rev-list", "--objects", "--all", "--no-object-names"])
    .split("\n")
    .sort();

/** Asserts the mirror holds what a plain build would: the remote's branches and nothing else. */
export function expectExactlyTheRemote() {
  expect(
    git(root, [`--git-dir=${mirrorPath()}`, "for-each-ref", "--format=%(refname) %(objectname)"]),
  ).toBe(git(remote, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"]));
  expect(allObjects()).toEqual(reachableObjects());
  expect(existsSync(path.join(mirrorPath(), "objects", "info", "alternates"))).toBe(false);
  expect(existsSync(path.join(mirrorPath(), "shallow"))).toBe(false);
  expect(existsSync(path.join(mirrorPath(), "FETCH_HEAD"))).toBe(false);
  git(root, [`--git-dir=${mirrorPath()}`, "fsck", "--full", "--strict"]);
}

/**
 * Records the size of every pack the remote serves, not a local repository's.
 * `upload-pack` reads its hook only from global configuration, which a mirror
 * fetch withholds from the remote it spawns, so `run` hands that one hook to
 * the mirror's remote fetches.
 */
export async function countRemotePackBytes(): Promise<{
  bytes: () => Promise<number>;
  run: typeof runCommand;
}> {
  const log = path.join(root, "remote-packs");
  const hook = path.join(root, "pack-hook.sh");
  const hookConfig = path.join(root, "pack-hook-config");
  await fs.writeFile(
    hook,
    `#!/bin/sh\ncase "$PWD" in ${remote}*) "$@" | tee -a "${log}" ;; *) exec "$@" ;; esac\n`,
    { mode: 0o755 },
  );
  await fs.writeFile(hookConfig, `[uploadpack]\n\tpackObjectsHook = ${hook}\n`);
  await fs.appendFile(process.env.GIT_CONFIG_GLOBAL!, `[include]\n\tpath = ${hookConfig}\n`);
  const run: typeof runCommand = (command, args, options = {}) =>
    runCommand(
      command,
      args,
      options.env?.GIT_CONFIG_GLOBAL === os.devNull
        ? { ...options, env: { ...options.env, GIT_CONFIG_GLOBAL: hookConfig } }
        : options,
    );
  return {
    run,
    bytes: async () =>
      fs.stat(log).then(
        (stats) => stats.size,
        () => 0,
      ),
  };
}

/** History too random to compress, so a download of it cannot be mistaken for a small one. */
export function commitLargeHistory() {
  writeFileSync(path.join(work, "big.bin"), randomBytes(512 * 1024));
  git(work, ["add", "."]);
  git(work, ["commit", "-qm", "big"]);
  git(work, ["push", "-q", "origin", "main"]);
}

/**
 * Registers the per-test fixture in the calling test file: a project root holding a bare
 * `remote.git` with one commit on `main` and a `work` clone of it, a data directory and a
 * storage. The remote and clone are built once per file and copied for each test, because
 * building them takes six Git spawns and no test changes the original.
 */
export function registerGitMirrorFixture(): void {
  let template: string;

  beforeAll(async () => {
    template = await fs.mkdtemp(path.join(os.tmpdir(), "ork-project-git-mirror-template-"));
    const config = path.join(template, "gitconfig");
    await fs.writeFile(config, "[user]\n\tname = T\n\temail = t@example.com\n");
    const run = (cwd: string, args: string[]): void => {
      const result = spawnSync("git", args, {
        cwd,
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" },
      });
      if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    };
    const templateRemote = path.join(template, "remote.git");
    const templateWork = path.join(template, "work");
    run(template, ["init", "-q", "--bare", "--initial-branch=main", templateRemote]);
    run(template, ["clone", "-q", templateRemote, templateWork]);
    run(templateWork, ["checkout", "-qb", "main"]);
    writeFileSync(path.join(templateWork, "one.txt"), "one\n");
    run(templateWork, ["add", "."]);
    run(templateWork, ["commit", "-qm", "change one.txt"]);
    run(templateWork, ["push", "-q", "origin", "main"]);
  });

  afterAll(async () => {
    await fs.rm(template, { recursive: true, force: true });
  });

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-project-git-mirror-"));
    process.env.GIT_CONFIG_GLOBAL = path.join(root, "gitconfig");
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    await fs.writeFile(
      process.env.GIT_CONFIG_GLOBAL,
      "[user]\n\tname = T\n\temail = t@example.com\n",
    );
    dataDir = path.join(root, "data");
    remote = path.join(root, "remote.git");
    work = path.join(root, "work");
    storage = new StorageService(dataDir);
    await storage.init();
    context = { storage };
    const copied = spawnSync(
      "cp",
      ["-a", path.join(template, "remote.git"), path.join(template, "work"), root],
      { encoding: "utf8" },
    );
    if (copied.status !== 0) throw new Error(`cp -a: ${copied.stderr}`);
    // The clone's origin is the template's remote until it is pointed at this test's copy.
    git(work, ["remote", "set-url", "origin", remote]);
  });

  afterEach(async () => {
    process.env.GIT_CONFIG_GLOBAL = savedEnv.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_NOSYSTEM = savedEnv.GIT_CONFIG_NOSYSTEM;
    if (savedEnv.GIT_CONFIG_GLOBAL === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    if (savedEnv.GIT_CONFIG_NOSYSTEM === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    await fs.rm(root, { recursive: true, force: true });
  });
}
