import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RootChangeFile } from "@orkestrator/protocol/coordinator-surfaces";
import type { CommandContext } from "./commands-context.js";
import { isProjectHomeEnvironment } from "./project-home-environment.js";
import { resolveProjectGitRoot } from "./project-git-root.js";
import { runCommand, runCommandBuffer } from "./shell.js";
import { containerExecArgs } from "./tmux-shared.js";

/**
 * The project checkout's uncommitted changes, and a user-approved patch of
 * some of them applied to a worker (todo 0142, item 1).
 *
 * Reading the checkout never writes to it: the listing is `git status`
 * without optional locks, and the patch is `git diff HEAD` against a
 * throwaway copy of the index in which the chosen untracked files are marked
 * intent-to-add, with a throwaway object store in front of the real one. The
 * checkout's own index, objects, refs and files are left exactly as they
 * were (`root-changes.test.ts` checks all four). Only the worker is written, and only with
 * `git apply`, which checks the whole patch first and applies all of it or
 * nothing.
 */

export const MAX_ROOT_CHANGE_FILES = 2_000;
export const MAX_ROOT_CHANGE_SELECTION = 500;
export const MAX_ROOT_CHANGE_PATCH_BYTES = 32 * 1024 * 1024;

const READ_ONLY_GIT_ENV = { GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1" };

/** Parse `git status --porcelain=v1 -z --no-renames --untracked-files=all`. */
export function parseRootChangeStatus(output: string): {
  files: RootChangeFile[];
  conflicts: number;
} {
  const files: RootChangeFile[] = [];
  let conflicts = 0;
  for (const entry of output.split("\0")) {
    if (entry.length < 4) continue;
    const x = entry[0]!;
    const y = entry[1]!;
    const file = entry.slice(3);
    if (x === "!" && y === "!") continue;
    if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
      conflicts += 1;
      continue;
    }
    const status: RootChangeFile["status"] =
      x === "?" && y === "?"
        ? "untracked"
        : x === "D" || y === "D"
          ? "deleted"
          : x === "A"
            ? "added"
            : "modified";
    files.push({ path: file, status });
  }
  return { files, conflicts };
}

export interface RootChangesListing {
  files: RootChangeFile[];
  truncated: boolean;
  conflicts: number;
  headCommit: string | null;
}

/** The checkout's changed files, for the user to pick from. Read-only. */
export async function listRootChanges(root: string): Promise<RootChangesListing> {
  const env = { ...process.env, ...READ_ONLY_GIT_ENV };
  const [status, head] = await Promise.all([
    runCommand("git", ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], {
      cwd: root,
      env,
      timeoutMs: 30_000,
    }),
    runCommand("git", ["rev-parse", "--verify", "--quiet", "HEAD"], {
      cwd: root,
      env,
      timeoutMs: 10_000,
    }).catch(() => null),
  ]);
  const parsed = parseRootChangeStatus(status.stdout);
  return {
    files: parsed.files.slice(0, MAX_ROOT_CHANGE_FILES),
    truncated: parsed.files.length > MAX_ROOT_CHANGE_FILES,
    conflicts: parsed.conflicts,
    headCommit: head?.stdout.trim() || null,
  };
}

/**
 * A binary patch from HEAD to the working tree for exactly `paths`.
 *
 * `paths` must already be checked against `listRootChanges`; untracked ones
 * are named separately so they can be marked intent-to-add in the scratch
 * index and show up as new files.
 */
export async function buildRootChangesPatch(
  root: string,
  paths: readonly string[],
  untracked: readonly string[],
): Promise<Buffer> {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "orkestrator-root-changes-"));
  try {
    const indexPath = path.join(scratch, "index");
    const objectsPath = path.join(scratch, "objects");
    await fs.mkdir(objectsPath);
    const gitPaths = await runCommand(
      "git",
      ["rev-parse", "--git-path", "index", "--git-path", "objects"],
      { cwd: root, env: { ...process.env, ...READ_ONLY_GIT_ENV }, timeoutMs: 10_000 },
    );
    const [gitIndex = "", gitObjects = ""] = gitPaths.stdout.split("\n");
    await fs
      .copyFile(path.resolve(root, gitIndex.trim()), indexPath)
      .catch((error: NodeJS.ErrnoException) => {
        // A repository with nothing staged yet may have no index file.
        if (error.code !== "ENOENT") throw error;
      });
    // Intent-to-add records the empty blob. Writing objects to a scratch
    // store, with the checkout's own store readable as an alternate, keeps
    // even that out of the checkout.
    const env = {
      ...process.env,
      ...READ_ONLY_GIT_ENV,
      GIT_INDEX_FILE: indexPath,
      GIT_OBJECT_DIRECTORY: objectsPath,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: path.resolve(root, gitObjects.trim()),
    };
    if (untracked.length > 0) {
      await runCommand("git", ["add", "--intent-to-add", "--", ...untracked], {
        cwd: root,
        env,
        timeoutMs: 60_000,
      });
    }
    const diff = await runCommandBuffer(
      "git",
      [
        "diff",
        "--binary",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "HEAD",
        "--",
        ...paths,
      ],
      { cwd: root, env, timeoutMs: 120_000 },
    );
    if (diff.stdout.length > MAX_ROOT_CHANGE_PATCH_BYTES) {
      throw new Error("The selected changes are larger than 32 MiB; pick fewer files.");
    }
    return diff.stdout;
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

/** Every changed path in this patch, from its `diff --git` headers. */
export function patchPaths(patch: Buffer): string[] {
  const paths = new Set<string>();
  for (const line of patch.toString("latin1").split("\n")) {
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (match) paths.add(match[2]!);
  }
  return Array.from(paths);
}

function gitFailure(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  // Git names the paths it could not apply; keep only that, never content.
  return (
    text
      .split("\n")
      .filter((line) => /^(error|fatal):/.test(line))
      .slice(0, 5)
      .join(" ")
      .slice(0, 500) || "git apply failed"
  );
}

export interface ApplyRootChangesInput {
  projectId: string;
  environmentId: string;
  paths: readonly string[];
}

export interface ApplyRootChangesOutcome {
  files: string[];
}

/**
 * Apply the user's selection of the checkout's changes to a worker.
 *
 * Refuses the project home (that would be the checkout itself), any path the
 * checkout does not currently report as changed, and a patch that does not
 * apply cleanly; in each case the worker is left untouched.
 */
export async function applyRootChanges(
  context: CommandContext,
  input: ApplyRootChangesInput,
): Promise<ApplyRootChangesOutcome> {
  if (input.paths.length === 0) throw new Error("Pick at least one file.");
  if (input.paths.length > MAX_ROOT_CHANGE_SELECTION) {
    throw new Error(`Pick at most ${MAX_ROOT_CHANGE_SELECTION} files.`);
  }
  const environment = await context.storage.getEnvironment(input.environmentId);
  if (!environment || environment.projectId !== input.projectId) {
    throw new Error("The worker environment is not in this project.");
  }
  if (isProjectHomeEnvironment(environment)) {
    throw new Error("The project checkout cannot receive its own changes.");
  }
  if (environment.deletionRequestedAt || environment.lifecycleOperation === "deleting") {
    throw new Error("The worker environment is being deleted.");
  }
  const root = await resolveProjectGitRoot(context.storage, input.projectId);
  const listing = await listRootChanges(root);
  if (!listing.headCommit) throw new Error("The checkout has no commit to diff against.");
  const changed = new Map(listing.files.map((file) => [file.path, file]));
  const selected = Array.from(new Set(input.paths));
  const unknown = selected.filter((file) => !changed.has(file));
  if (unknown.length > 0) {
    throw new Error(
      `${unknown.length} selected file${unknown.length === 1 ? " is" : "s are"} no longer changed in the checkout; reopen the request to pick again.`,
    );
  }
  const untracked = selected.filter((file) => changed.get(file)!.status === "untracked");
  const patch = await buildRootChangesPatch(root, selected, untracked);
  if (patch.length === 0) throw new Error("The selected files have no changes to apply.");
  const files = patchPaths(patch);

  if (environment.environmentType === "local") {
    if (!environment.worktreePath) throw new Error("The worker has no worktree.");
    const release = context.runtime.environments.fence.beginMutation(environment.id);
    try {
      for (const args of [
        ["apply", "--check", "--binary", "-"],
        ["apply", "--binary", "-"],
      ]) {
        await runCommand("git", args, {
          cwd: environment.worktreePath,
          stdin: patch,
          timeoutMs: 120_000,
        }).catch((error: unknown) => {
          throw new Error(`The changes do not apply to the worker: ${gitFailure(error)}`);
        });
      }
    } finally {
      release();
    }
    return { files };
  }

  if (environment.status !== "running" || !environment.containerId) {
    throw new Error("Start the worker container before applying changes to it.");
  }
  for (const args of [
    ["git", "apply", "--check", "--binary", "-"],
    ["git", "apply", "--binary", "-"],
  ]) {
    await runCommand("docker", containerExecArgs(environment.containerId, args, true), {
      stdin: patch,
      timeoutMs: 120_000,
    }).catch((error: unknown) => {
      throw new Error(`The changes do not apply to the worker: ${gitFailure(error)}`);
    });
  }
  return { files };
}
