import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RootChangeFile } from "@orkestrator/protocol/coordinator-surfaces";
import type { CommandContext } from "./commands-context.js";
import type { Environment } from "./models.js";
import { isProjectHomeEnvironment } from "./project-home-environment.js";
import { resolveProjectGitRoot } from "./project-git-root.js";
import { runGitWithFsmonitorFallback } from "./git-fsmonitor.js";
import { CommandFailedError, runCommand, runCommandBuffer } from "./shell.js";
import { containerExecArgs } from "./tmux-shared.js";

/**
 * The project checkout's uncommitted changes, and a user-approved patch of
 * some of them applied to a worker (coordinator.md, "Uncommitted changes in a worker").
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

/** The largest patch a caller accepts, and how it refuses a larger one. */
export interface RootChangesPatchLimit {
  maxBytes: number;
  /** The whole refusal: it must name no file content. */
  message: string;
}

/** A worker on this node. Another node's limit is `root-changes-node.ts`'s. */
export const LOCAL_ROOT_CHANGES_PATCH_LIMIT: RootChangesPatchLimit = {
  maxBytes: MAX_ROOT_CHANGE_PATCH_BYTES,
  message: "The selected changes are larger than 32 MiB; pick fewer files.",
};

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
    runGitWithFsmonitorFallback(
      ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"],
      { cwd: root, env, timeoutMs: 30_000 },
    ),
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
 *
 * The capture stops as soon as the patch passes `limit.maxBytes`, and the
 * refusal is the caller's own message whatever the size, so a selection far
 * over the limit reads the same as one just over it.
 *
 * The headers are always `a/` and `b/`: the checkout's own
 * `diff.mnemonicPrefix`, `diff.noprefix` or `diff.srcPrefix`/`dstPrefix`
 * would otherwise reach the patch, and the receiving node reads the file
 * list from those headers (`patchPaths`).
 */
export async function buildRootChangesPatch(
  root: string,
  paths: readonly string[],
  untracked: readonly string[],
  limit: RootChangesPatchLimit = LOCAL_ROOT_CHANGES_PATCH_LIMIT,
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
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "HEAD",
        "--",
        ...paths,
      ],
      { cwd: root, env, timeoutMs: 120_000, maxOutputBytes: limit.maxBytes },
    ).catch((error: unknown) => {
      if (error instanceof CommandFailedError && error.outputLimitExceeded)
        throw new Error(limit.message);
      throw new Error("Could not capture the selected changes; pick fewer files and retry.");
    });
    if (diff.stdout.length > limit.maxBytes) throw new Error(limit.message);
    return diff.stdout;
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

/** Decode Git's C-quoted UTF-8 paths, including octal byte escapes. */
function gitPath(value: string): string {
  if (!value.startsWith('"')) return value;
  const bytes: number[] = [];
  const escapes: Record<string, number> = {
    a: 7,
    b: 8,
    t: 9,
    n: 10,
    v: 11,
    f: 12,
    r: 13,
    '"': 34,
    "\\": 92,
  };
  for (let i = 1; i < value.length - 1; i++) {
    if (value[i] === "\\") {
      const octal = /^[0-7]{1,3}/.exec(value.slice(i + 1));
      if (octal) {
        bytes.push(parseInt(octal[0], 8));
        i += octal[0].length;
      } else {
        bytes.push(escapes[value[++i]!] ?? 63);
      }
    } else {
      const point = value.codePointAt(i)!;
      bytes.push(...Buffer.from(String.fromCodePoint(point)));
      if (point > 0xffff) i++;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Paths from no-rename Git diff headers, with UTF-8 and C quoting preserved. */
export function patchPaths(patch: Buffer): string[] {
  const paths = new Set<string>();
  for (const line of patch.toString("utf8").split("\n")) {
    if (!line.startsWith("diff --git ")) continue;
    const header = line.slice(11);
    if (header.startsWith('"')) {
      const match = /^"(?:[^"\\]|\\.)*" (.+)$/.exec(header);
      if (match) paths.add(gitPath(match[1]!).slice(2));
    } else {
      // --no-renames produces the same path twice. Splitting at the middle
      // handles even an unquoted filename containing " b/" or spaces.
      const first = header.slice(0, (header.length - 1) / 2);
      const second = header.slice((header.length + 1) / 2);
      if (first.startsWith("a/") && second.startsWith("b/") && first.slice(2) === second.slice(2))
        paths.add(second.slice(2));
    }
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

/** Refuses an empty or oversized selection before anything is read. */
export function assertRootChangeSelection(paths: readonly string[]): void {
  if (paths.length === 0) throw new Error("Pick at least one file.");
  if (paths.length > MAX_ROOT_CHANGE_SELECTION) {
    throw new Error(`Pick at most ${MAX_ROOT_CHANGE_SELECTION} files.`);
  }
}

/**
 * The patch of exactly the picked files, built from the project's checkout on
 * this node. Refuses any path the checkout no longer reports as changed and
 * a selection with nothing to apply. Reads the checkout only.
 */
export async function buildSelectedRootChangesPatch(
  storage: CommandContext["storage"],
  projectId: string,
  paths: readonly string[],
  limit: RootChangesPatchLimit = LOCAL_ROOT_CHANGES_PATCH_LIMIT,
): Promise<{ patch: Buffer; files: string[] }> {
  const root = await resolveProjectGitRoot(storage, projectId);
  const listing = await listRootChanges(root);
  if (!listing.headCommit) throw new Error("The checkout has no commit to diff against.");
  const changed = new Map(listing.files.map((file) => [file.path, file]));
  const selected = Array.from(new Set(paths));
  const unknown = selected.filter((file) => !changed.has(file));
  if (unknown.length > 0) {
    throw new Error(
      `${unknown.length} selected file${unknown.length === 1 ? " is" : "s are"} no longer changed in the checkout; reopen the request to pick again.`,
    );
  }
  const untracked = selected.filter((file) => changed.get(file)!.status === "untracked");
  const patch = await buildRootChangesPatch(root, selected, untracked, limit);
  if (patch.length === 0) throw new Error("The selected files have no changes to apply.");
  return { patch, files: patchPaths(patch) };
}

/**
 * Run `operation` on one worker of `projectId` that may receive a patch, with
 * check/apply pairs serialized: a namespaced durable lock across approvals
 * and backend processes, and the runtime fence that also excludes worker
 * moves. The worker is re-read inside both.
 */
export async function withReceivingWorker<T>(
  context: CommandContext,
  projectId: string,
  environmentId: string,
  operation: (environment: Environment) => Promise<T>,
): Promise<T> {
  return context.storage.withProjectCreationLock(`root-changes:${environmentId}`, async () => {
    const release = context.runtime.environments.fence.beginMutation(environmentId);
    try {
      const environment = await context.storage.getEnvironment(environmentId);
      if (!environment || environment.projectId !== projectId) {
        throw new Error("The worker environment is not in this project.");
      }
      if (isProjectHomeEnvironment(environment)) {
        throw new Error("The project checkout cannot receive its own changes.");
      }
      if (environment.deletionRequestedAt || environment.lifecycleOperation === "deleting") {
        throw new Error("The worker environment is being deleted.");
      }
      return await operation(environment);
    } finally {
      release();
    }
  });
}

/** `git apply --check`, then `git apply`, in the worker: all of the patch or none of it. */
export async function applyPatchInWorker(environment: Environment, patch: Buffer): Promise<void> {
  if (environment.environmentType === "local") {
    if (!environment.worktreePath) throw new Error("The worker has no worktree.");
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
    return;
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
}

/**
 * Apply the user's selection of the checkout's changes to a worker on this
 * node.
 *
 * Refuses the project home (that would be the checkout itself), any path the
 * checkout does not currently report as changed, and a patch that does not
 * apply cleanly; in each case the worker is left untouched. A worker on
 * another node is `root-changes-node.ts`'s.
 */
export async function applyRootChanges(
  context: CommandContext,
  input: ApplyRootChangesInput,
): Promise<ApplyRootChangesOutcome> {
  assertRootChangeSelection(input.paths);
  return withReceivingWorker(context, input.projectId, input.environmentId, async (environment) => {
    const { patch, files } = await buildSelectedRootChangesPatch(
      context.storage,
      input.projectId,
      input.paths,
    );
    await applyPatchInWorker(environment, patch);
    return { files };
  });
}
