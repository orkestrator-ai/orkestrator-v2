import { fs, path, createProject, CommandFailedError, runCommand } from "./commands-dependencies.js";
import type { ClaudeModelCatalogSnapshot, Project, StorageService } from "./commands-dependencies.js";
import { enqueueContainerBridgeOperation, startLocalServer } from "./commands-servers.js";
import { startContainerClaudeServer, fetchClaudeBridgeModelCatalog } from "./commands-containers.js";
import type { CommandContext } from "./commands-context.js";

export function conciseError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}

export function cleanupErrorMessage(error: unknown): string {
  if (error instanceof Error) return conciseError(error);
  if (typeof error === "string" && error.trim()) {
    return error.length > 500 ? `${error.slice(0, 500)}…` : error;
  }
  return "An unexpected error occurred";
}

/**
 * Every value this can return, so the persisted field is a closed set rather
 * than a bounded slice of child output. Nothing derived from a command,
 * a path, or a repository ever reaches it.
 */
export const ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES = {
  unknown: "Environment start failed. Check the backend logs and retry.",
  noLocalPath: "Project has no local path - cannot create a local worktree",
  setupScript: "Environment setup script failed.",
  timedOut: "Environment start timed out. Check the container runtime and retry.",
  runtimeUnavailable: "The container runtime is unavailable. Start it and retry.",
  imageUnavailable: "The environment image is unavailable. Rebuild it and retry.",
  diskFull: "The host has run out of disk space. Free space and retry.",
} as const;

/**
 * Classifies a subprocess/storage failure into a message that is safe to
 * persist and render. Raw command errors can contain clone URLs, host paths,
 * environment variables, and child output, so the raw text never crosses this
 * boundary — the return value is always one of the constants above.
 *
 * Classification prefers `CommandFailedError`'s structured outcome over the
 * message. A timeout in particular is invisible in the text: `execFile` kills
 * the child, leaving only the generic "Command failed: <argv>".
 */
export function environmentLifecycleErrorMessage(error: unknown): string {
  if (error instanceof CommandFailedError) {
    if (error.timedOut) return ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.timedOut;
    if (error.executableMissing) return ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.runtimeUnavailable;
  }

  const message = error instanceof Error ? error.message : "";
  if (message === ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.noLocalPath) {
    return ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.noLocalPath;
  }
  if (message === "Setup script failed") {
    return ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.setupScript;
  }
  // Matched against what the Docker CLI actually emits, not a paraphrase.
  if (/cannot connect to the docker daemon|is the docker daemon running|docker daemon is not running|error during connect/i.test(message)) {
    return ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.runtimeUnavailable;
  }
  if (/unable to find image|pull access denied|manifest unknown|manifest for .* not found|no such image|repository does not exist/i.test(message)) {
    return ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.imageUnavailable;
  }
  if (/no space left on device/i.test(message)) {
    return ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.diskFull;
  }
  return ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.unknown;
}

export const LIFECYCLE_LOG_DETAIL_MAX_CHARS = 500;

/**
 * Strips the credential shapes a subprocess failure realistically carries.
 *
 * `runCommand` already removes values the caller declared secret, but a child
 * echoes things the caller never named — most importantly the remote URL of a
 * failed clone or fetch, which carries its own credentials in userinfo.
 */
export function scrubLifecycleLogDetail(detail: string): string {
  const scrubbed = detail
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1[redacted]@")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]+\b/gi, "[redacted]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]+\b/gi, "[redacted]")
    .replace(/\bsk-[A-Za-z0-9._-]{16,}\b/gi, "[redacted]")
    .replace(/\bxox[abposr]-[A-Za-z0-9-]+\b/gi, "[redacted]");

  return scrubbed.length > LIFECYCLE_LOG_DETAIL_MAX_CHARS
    ? `${scrubbed.slice(0, LIFECYCLE_LOG_DETAIL_MAX_CHARS)}…`
    : scrubbed;
}

/**
 * The persisted message is a fixed category, so without this the cause of a
 * failed start survives nowhere and "check the backend logs" is a dead end.
 *
 * The child's own text is the useful part, so it is logged — scrubbed, and
 * alongside the structured outcome, which is the only place a timeout or a
 * missing runtime is distinguishable from an ordinary non-zero exit.
 */
export function logEnvironmentLifecycleFailure(
  operation: string,
  environmentId: string,
  error: unknown,
): void {
  const detail = scrubLifecycleLogDetail(
    error instanceof Error ? error.message : String(error),
  );
  const outcome = error instanceof CommandFailedError
    ? ` (timedOut=${error.timedOut} executableMissing=${error.executableMissing} exitCode=${error.exitCode} signal=${error.signal})`
    : "";
  console.error(
    `[environment-lifecycle] ${operation} failed for ${environmentId}: ${environmentLifecycleErrorMessage(error)}${outcome} — ${detail}`,
  );
}

export async function refreshClaudeModelCatalog(
  environmentId: string,
  context: CommandContext,
): Promise<ClaudeModelCatalogSnapshot> {
  const environment = await context.storage.getEnvironment(environmentId);
  if (!environment) throw new Error(`Environment not found: ${environmentId}`);

  let port: number;
  let authToken: string | undefined;
  if (environment.environmentType === "local") {
    const started = await startLocalServer(environmentId, context, "claude");
    port = started.port;
    authToken = started.authToken;
  } else {
    const containerId = environment.containerId;
    if (!containerId) {
      throw new Error("Container ID is required for Claude model discovery");
    }
    const started = await enqueueContainerBridgeOperation(
      "claude",
      containerId,
      () => startContainerClaudeServer(containerId),
    );
    port = started.hostPort;
    authToken = started.authToken;
  }

  const catalog = await fetchClaudeBridgeModelCatalog(port, authToken);
  const snapshot: ClaudeModelCatalogSnapshot = {
    environmentId,
    models: catalog.models,
    source: catalog.source,
    fetchedAt: catalog.fetchedAt,
    sdkVersion: catalog.sdkVersion,
    cliVersion: catalog.cliVersion,
    stale: catalog.source !== "sdk",
  };
  await context.storage.updateEnvironment(environmentId, {
    claudeModelCatalog: snapshot,
  });
  context.emit("claude-model-catalog-updated", snapshot);
  if (catalog.source === "sdk") {
    // This host-level cache improves the next launch, but it is not part of the
    // authoritative per-environment refresh. Do not hold a successful response
    // or event behind storage lock contention or an unrelated cache failure.
    void context.storage.cacheAgentModelCatalog("claude", catalog.models)
      .catch((error) => {
        console.warn(
          "[ElectronBackend] Failed to persist the Claude model catalogue:",
          conciseError(error),
        );
      });
  }
  return snapshot;
}

export function resolveNewProjectPath(value: string): string {
  const trimmed = value.trim();
  if (!path.isAbsolute(trimmed)) {
    throw new Error("Project path must be an absolute path");
  }
  const resolved = path.resolve(trimmed);
  const repositoryName = path.basename(resolved);
  if (!repositoryName || resolved === path.parse(resolved).root) {
    throw new Error("Project path must name a folder, not a filesystem root");
  }
  return resolved;
}

export const PROJECT_PATH_NOT_A_DIRECTORY =
  "Project path must be a directory and cannot be a symbolic link";

/**
 * macOS (APFS/HFS+) and Windows are case-insensitive by default, so a key that
 * preserved case would let `/p/Foo` and `/p/foo` take different creation locks
 * while targeting one physical directory — and the loser's rollback would then
 * delete the `.git` the winner is using. Folding costs a spurious duplicate
 * report only on opt-in case-sensitive volumes, which is an error message
 * rather than a race.
 */
export function comparableProjectPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" || process.platform === "darwin"
    ? resolved.toLowerCase()
    : resolved;
}

export async function canonicalProjectPath(value: string): Promise<string> {
  const resolved = path.resolve(value);
  const missingSegments: string[] = [];
  let existingAncestor = resolved;

  while (true) {
    try {
      await fs.lstat(existingAncestor);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // An ancestor that is a regular file answers ENOTDIR, not ENOENT. Report
      // the same actionable message the directory check would, rather than
      // letting a raw errno string reach the user.
      if (code === "ENOTDIR") throw new Error(PROJECT_PATH_NOT_A_DIRECTORY);
      if (code !== "ENOENT") {
        throw new Error(`Could not inspect the project path: ${conciseError(error)}`);
      }
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) throw error;
      missingSegments.unshift(path.basename(existingAncestor));
      existingAncestor = parent;
    }
  }

  try {
    return path.join(await fs.realpath(existingAncestor), ...missingSegments);
  } catch (error) {
    throw new Error(`Could not resolve the project path: ${conciseError(error)}`);
  }
}

export async function projectPathKey(value: string): Promise<string> {
  try {
    return comparableProjectPath(await canonicalProjectPath(value));
  } catch {
    // An existing project whose folder has since moved must not block an
    // unrelated creation; fall back to the uncanonicalized comparison.
    return comparableProjectPath(value);
  }
}

/**
 * Runs inside `addProject`'s critical section as well as before the CLI work,
 * so a concurrent `add_project` cannot slip the same local path in during the
 * minutes that repository creation takes.
 */
export function duplicateLocalPathGuard(
  targetKey: string,
  displayPath: string,
): (projects: Project[]) => Promise<void> {
  return async (projects) => {
    for (const project of projects) {
      if (project.localPath === null) continue;
      if (await projectPathKey(project.localPath) === targetKey) {
        throw new Error(`A project already uses this local path: ${displayPath}`);
      }
    }
  };
}

/**
 * `git remote get-url` resolves `url.<base>.insteadOf` rewrites, so a developer
 * whose git config injects a token would have that credential returned here,
 * persisted into projects.json and announced to every gateway client. Read the
 * raw configured value instead, and strip any userinfo the remote itself
 * carries: a bare `https://TOKEN@host/…` is as much a secret as `user:TOKEN@`.
 */
export function withoutUrlCredentials(gitUrl: string): string {
  return gitUrl.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/?#]*@/, "$1");
}

export async function readOriginUrl(projectPath: string, run: typeof runCommand): Promise<string> {
  const { stdout } = await run(
    "git",
    ["-C", projectPath, "config", "--get", "remote.origin.url"],
    { timeoutMs: 10_000 },
  );
  return withoutUrlCredentials(stdout.trim());
}

export const SCRATCH_COMMIT_AUTHOR = "Orkestrator";
export const SCRATCH_COMMIT_EMAIL = "projects@orkestrator.local";
export const SCRATCH_COMMIT_SUBJECT = "Initial commit";

/**
 * A `gh` failure that may have created the remote deliberately leaves the local
 * repository in place, so a retry has to recognize Orkestrator's own handiwork
 * instead of failing the emptiness check forever. Only a pristine scratch
 * repository resumes: one Orkestrator-authored commit on `main`, no remotes,
 * and a clean working tree. Anything a user has touched is not resumable.
 */
export async function isResumableScratchRepository(
  projectPath: string,
  run: typeof runCommand,
): Promise<boolean> {
  const git = async (args: string[]): Promise<string> => (
    await run("git", ["-C", projectPath, ...args], { timeoutMs: 10_000 })
  ).stdout.trim();

  try {
    if (await git(["rev-list", "--count", "HEAD"]) !== "1") return false;
    if (await git(["symbolic-ref", "--short", "HEAD"]) !== "main") return false;
    if (await git(["remote"]) !== "") return false;
    if (await git(["status", "--porcelain"]) !== "") return false;
    const identity = await git(["log", "-1", "--format=%an%n%ae%n%s"]);
    return identity === [
      SCRATCH_COMMIT_AUTHOR,
      SCRATCH_COMMIT_EMAIL,
      SCRATCH_COMMIT_SUBJECT,
    ].join("\n");
  } catch {
    return false;
  }
}

export type ProjectDirectoryIdentity = { dev: number; ino: number; realPath: string };

/**
 * Rollback deletes by path, and nothing pins the ancestors of that path
 * between validation and removal. Re-proving the directory's identity means a
 * swapped ancestor changes both realpath and the inode, so the recursive
 * delete declines instead of following the symlink somewhere else.
 */
export async function projectDirectoryStillMatches(
  projectPath: string,
  identity: ProjectDirectoryIdentity,
): Promise<boolean> {
  const stats = await fs.lstat(projectPath);
  if (stats.isSymbolicLink() || !stats.isDirectory()) return false;
  if (stats.dev !== identity.dev || stats.ino !== identity.ino) return false;
  return (await fs.realpath(projectPath)) === identity.realPath;
}

/**
 * `fs.mkdir(p, { recursive: true })` reports the *topmost* directory it
 * created, not the leaf, so removing only the leaf strands every intermediate
 * directory this call made. `rmdir` refuses a non-empty directory, which makes
 * walking back up inherently non-destructive.
 */
export async function removeCreatedDirectoryChain(leaf: string, createdRoot: string): Promise<void> {
  let current = leaf;
  while (true) {
    try {
      await fs.rmdir(current);
    } catch {
      return;
    }
    if (current === createdRoot) return;
    const parent = path.dirname(current);
    if (parent === current || parent.length < createdRoot.length) return;
    current = parent;
  }
}

export async function rollbackScratchRepository(options: {
  projectPath: string;
  createdRoot: string | null;
  attemptedGitInit: boolean;
  identity: ProjectDirectoryIdentity | null;
}): Promise<void> {
  const { projectPath, createdRoot, attemptedGitInit, identity } = options;
  try {
    if (identity) {
      if (!await projectDirectoryStillMatches(projectPath, identity)) return;
      if (attemptedGitInit && (await fs.readdir(projectPath)).includes(".git")) {
        await fs.rm(path.join(projectPath, ".git"), { recursive: true, force: true });
      }
    }
    // Only ever removes directories this call created, and only while they are
    // empty — content that appeared underneath keeps the directory alive.
    if (createdRoot) await removeCreatedDirectoryChain(projectPath, createdRoot);
  } catch {
    // Rollback is best effort; retain the original actionable failure.
  }
}

export async function createProjectFromScratch(
  requestedPath: string,
  storage: StorageService,
  run: typeof runCommand,
): Promise<Project> {
  const projectPath = resolveNewProjectPath(requestedPath);
  const repositoryName = path.basename(projectPath);
  if (repositoryName.startsWith("-")) {
    throw new Error("Project folder name cannot begin with a dash");
  }
  const targetKey = comparableProjectPath(await canonicalProjectPath(projectPath));
  const assertPathIsFree = duplicateLocalPathGuard(targetKey, projectPath);

  return storage.withProjectCreationLock(targetKey, async () => {
    await assertPathIsFree(await storage.loadProjects());

    let createdRoot: string | null = null;
    let attemptedGitInit = false;
    let identity: ProjectDirectoryIdentity | null = null;
    const remote = { state: "none" as "none" | "ambiguous" | "created" };

    try {
      let stats;
      try {
        stats = await fs.lstat(projectPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        createdRoot = (await fs.mkdir(projectPath, { recursive: true })) ?? null;
        stats = await fs.lstat(projectPath);
      }

      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error(PROJECT_PATH_NOT_A_DIRECTORY);
      }

      // Recorded before any destructive step so rollback can prove it is
      // removing the directory it validated rather than one swapped in since.
      identity = {
        dev: stats.dev,
        ino: stats.ino,
        realPath: await fs.realpath(projectPath),
      };

      const entries = await fs.readdir(projectPath);
      const resuming = entries.length > 0;
      if (resuming) {
        const recoverable = entries.length === 1 && entries[0] === ".git"
          && await isResumableScratchRepository(projectPath, run);
        if (!recoverable) {
          throw new Error("Project path must be new or an empty directory");
        }
      }

      if (!resuming) {
        try {
          attemptedGitInit = true;
          await run("git", ["-C", projectPath, "init", "-b", "main"], {
            timeoutMs: 30_000,
          });
        } catch (error) {
          const detail = error instanceof CommandFailedError && error.executableMissing
            ? "Git is not installed or available on PATH"
            : conciseError(error);
          throw new Error(`Could not initialize the Git repository: ${detail}`);
        }

        try {
          await run("git", [
            "-C",
            projectPath,
            "-c",
            `user.name=${SCRATCH_COMMIT_AUTHOR}`,
            "-c",
            `user.email=${SCRATCH_COMMIT_EMAIL}`,
            "commit",
            "--allow-empty",
            "--no-gpg-sign",
            "-m",
            SCRATCH_COMMIT_SUBJECT,
          ], { timeoutMs: 30_000 });
        } catch (error) {
          throw new Error(`Could not create the initial Git commit: ${conciseError(error)}`);
        }
      }

      try {
        // A timeout or transport error may arrive after GitHub accepted the API
        // request. Mark the outcome ambiguous before invoking gh so rollback
        // never deletes the only recoverable local repository in that case.
        remote.state = "ambiguous";
        await run("gh", [
          "repo",
          "create",
          repositoryName,
          "--private",
          `--source=${projectPath}`,
          "--remote=origin",
        ], {
          timeoutMs: 120_000,
        });
        remote.state = "created";
      } catch (error) {
        if (error instanceof CommandFailedError && error.executableMissing) {
          remote.state = "none";
          throw new Error(
            "Could not create the private GitHub repository: GitHub CLI is not installed. "
            + "Install gh and run `gh auth login`, then retry",
          );
        }
        throw new Error(`Could not create the private GitHub repository: ${conciseError(error)}`);
      }

      const gitUrl = await readOriginUrl(projectPath, run);
      if (!gitUrl) throw new Error("Could not verify the origin remote");

      await run(
        "git",
        ["-C", projectPath, "push", "--set-upstream", "origin", "main"],
        { timeoutMs: 120_000 },
      );

      return await storage.addProject(createProject(gitUrl, projectPath), assertPathIsFree);
    } catch (error) {
      if (remote.state === "none") {
        await rollbackScratchRepository({ projectPath, createdRoot, attemptedGitInit, identity });
      }
      if (remote.state === "created") {
        throw new Error(
          "The local and private GitHub repositories were created, but Orkestrator could not finish setup. "
          + `Add the existing repository instead. ${conciseError(error)}`,
        );
      }
      if (remote.state === "ambiguous") {
        throw new Error(
          "The local Git repository was preserved because GitHub may have created the private repository. "
          + "Check GitHub, then retry the same path to resume from the local repository. "
          + `${conciseError(error)}`,
        );
      }
      throw error;
    }
  });
}

