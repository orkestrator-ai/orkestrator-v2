import { createHash } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

import { validateGitRefName } from "./commands-agent-support.js";
import type { CommandContext } from "./commands-context.js";
import { toClientEnvironment } from "./commands-terminal.js";
import { ORKESTRATOR_PROJECT_CONFIG } from "./constants.js";
import type { Environment } from "./models.js";
import { runCommand } from "./shell.js";

/**
 * The trust gate in front of a local environment's `setupLocal` commands.
 *
 * Those commands come from `orkestrator-ai.json` in the environment's own
 * worktree, so from whatever branch it was created on, and run in the user's
 * login shell on the host. A branch a container agent pushed, or a stranger's
 * pull request, would otherwise turn "contained in Docker" into "runs on the
 * host". A list runs without asking only when it is exactly the default
 * branch's, or one the user approved for the project on this machine
 * (`storage.setupApprovals`); otherwise setup is held and the user decides.
 */

/** Read and parse budget for `orkestrator-ai.json`; real ones are a few hundred bytes. */
const MAX_PROJECT_CONFIG_BYTES = 256 * 1024;

/** Git reading a ref's blob must not run anything the checkout's config names. */
const HARDENED_GIT = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"] as const;

/** `setupLocal` from `orkestrator-ai.json` text: a string or an array of strings. */
export function parseSetupLocalCommands(text: string): string[] {
  const parsed = JSON.parse(text) as { setupLocal?: unknown } | null;
  const setupLocal = parsed && typeof parsed === "object" ? parsed.setupLocal : undefined;
  if (typeof setupLocal === "string") return setupLocal.trim() ? [setupLocal] : [];
  if (Array.isArray(setupLocal))
    return setupLocal.filter(
      (item): item is string => typeof item === "string" && item.trim().length > 0,
    );
  return [];
}

/**
 * The worktree's `setupLocal` commands. The file is opened without following
 * a link: a branch could otherwise commit `orkestrator-ai.json` as a symlink
 * to any JSON file on the host.
 */
export async function readSetupLocalCommands(worktreePath: string): Promise<string[]> {
  const configPath = path.join(worktreePath, ORKESTRATOR_PROJECT_CONFIG);
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(configPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    if (code === "ELOOP" || code === "EMLINK") {
      throw new Error(`${ORKESTRATOR_PROJECT_CONFIG} is a link; setup reads only a regular file`);
    }
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error(`${ORKESTRATOR_PROJECT_CONFIG} is not a regular file`);
    }
    if (stats.size > MAX_PROJECT_CONFIG_BYTES) {
      throw new Error(
        `${ORKESTRATOR_PROJECT_CONFIG} is larger than ${MAX_PROJECT_CONFIG_BYTES} bytes`,
      );
    }
    return parseSetupLocalCommands(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

/** Content identity of a command list: order and exact text, nothing else. */
export function setupCommandsHash(commands: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(commands)).digest("hex");
}

export type GitBlobReader = (projectPath: string, ref: string) => Promise<string | null>;

/** The blob at `ref:orkestrator-ai.json`, `null` when the ref or the file is absent. */
const readConfigBlob: GitBlobReader = async (projectPath, ref) => {
  const exists = await runCommand(
    "git",
    [...HARDENED_GIT, "-C", projectPath, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    { timeoutMs: 10_000 },
  ).then(
    () => true,
    () => false,
  );
  if (!exists) return null;
  return runCommand(
    "git",
    [
      ...HARDENED_GIT,
      "-C",
      projectPath,
      "cat-file",
      "blob",
      `${ref}:${ORKESTRATOR_PROJECT_CONFIG}`,
    ],
    { timeoutMs: 10_000 },
  ).then(
    ({ stdout }) => stdout,
    // The ref exists and has no config: the default branch runs no setup.
    () => "",
  );
};

/**
 * The default branch's `setupLocal`, read from the project's checkout without
 * fetching: the remote-tracking ref first (what a remote project's
 * environments start from), then the local branch (a `project init` project
 * has no remote). `null` when neither exists or the file does not parse, so
 * the default branch is no trust source at all rather than an empty one.
 */
export async function readDefaultBranchSetupCommands(
  projectPath: string,
  defaultBranch: string,
  readBlob: GitBlobReader = readConfigBlob,
): Promise<string[] | null> {
  let branch: string;
  try {
    branch = validateGitRefName(defaultBranch, "default branch");
  } catch {
    return null;
  }
  for (const ref of [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`]) {
    const blob = await readBlob(projectPath, ref);
    if (blob === null) continue;
    if (blob.length > MAX_PROJECT_CONFIG_BYTES) return null;
    if (!blob.trim()) return [];
    try {
      return parseSetupLocalCommands(blob);
    } catch {
      return null;
    }
  }
  return null;
}

export type SetupTrust =
  | { trusted: true; source: "default-branch" | "approved" | "approved-now" }
  | { trusted: false; hash: string };

/**
 * Whether `commands` may run without asking. `approvedHash` is the hash the
 * user just approved for this run; it counts only when it is these commands.
 */
export async function evaluateSetupTrust(
  input: {
    projectId: string;
    projectPath: string | null | undefined;
    defaultBranch: string;
    commands: readonly string[];
    approvedHash?: string;
  },
  storage: Pick<CommandContext["storage"], "setupApprovals">,
  readBlob?: GitBlobReader,
): Promise<SetupTrust> {
  const hash = setupCommandsHash(input.commands);
  if (input.approvedHash === hash) return { trusted: true, source: "approved-now" };
  if (input.projectPath) {
    const defaults = await readDefaultBranchSetupCommands(
      input.projectPath,
      input.defaultBranch,
      readBlob,
    );
    if (defaults && setupCommandsHash(defaults) === hash) {
      return { trusted: true, source: "default-branch" };
    }
  }
  if (storage.setupApprovals.isSetupCommandsApproved(input.projectId, hash)) {
    return { trusted: true, source: "approved" };
  }
  return { trusted: false, hash };
}

/** The trust decision for a local environment's commands, from its project's records. */
export async function evaluateEnvironmentSetupTrust(
  environment: Environment,
  commands: readonly string[],
  context: Pick<CommandContext, "storage">,
  approvedHash?: string,
): Promise<SetupTrust> {
  const project = await context.storage.getProject(environment.projectId);
  const repoConfig = await context.storage.getRepositoryConfig(environment.projectId);
  return evaluateSetupTrust(
    {
      projectId: environment.projectId,
      projectPath: project?.localPath,
      defaultBranch: repoConfig.defaultBranch,
      commands,
      approvedHash,
    },
    context.storage,
  );
}

export const SETUP_APPROVAL_MESSAGE =
  "Setup did not run: this branch's setup commands differ from the default branch's and have not been approved on this machine.";

/**
 * Records a held setup: `failed` with `setupApprovalRequired`, so everything
 * that waits on setup stops waiting, and nothing re-runs it on its own. Marks
 * the environment for the user's attention and tells the coordinator that
 * launched it, if any.
 */
export async function holdEnvironmentSetupForApproval(
  environment: Environment,
  hash: string,
  context: CommandContext,
): Promise<Environment> {
  const now = new Date().toISOString();
  const session = context.runtime.environments.setupSession(environment.id);
  if (session?.running) {
    context.runtime.environments.recordSetupSession({
      ...session,
      running: false,
      completedAt: now,
      success: false,
      error: SETUP_APPROVAL_MESSAGE,
    });
  }
  const updated = await context.storage.updateEnvironment(environment.id, {
    setupPhase: "failed",
    setupApprovalRequired: true,
    setupCompletedAt: now,
    lifecycleError: SETUP_APPROVAL_MESSAGE,
  });
  await context.storage
    .recordEnvironmentAgentAttention(
      environment.id,
      [`setup-approval:${hash}`],
      now,
      "setup_approval",
    )
    .catch((error: unknown) => {
      console.warn("[setup] Could not record setup approval attention:", (error as Error)?.name);
    });
  await context.coordinators?.noteWorkerSetupApproval(updated).catch((error: unknown) => {
    console.warn(
      "[setup] Could not tell the coordinator about held setup:",
      (error as Error)?.name,
    );
  });
  context.emit("environment-setup-complete", {
    environment_id: environment.id,
    success: false,
    error: SETUP_APPROVAL_MESSAGE,
    environment: toClientEnvironment(updated),
  });
  return updated;
}

export interface EnvironmentSetupApproval {
  environmentId: string;
  projectId: string;
  /** Pass back unchanged to approve exactly these commands. */
  hash: string;
  commands: string[];
  defaultBranch: string;
  /** `null` when the default branch could not be read. */
  defaultBranchCommands: string[] | null;
  approvalRequired: boolean;
}

/** What the approval panel shows: the commands, and what the default branch runs instead. */
export async function describeEnvironmentSetupApproval(
  environment: Environment,
  context: Pick<CommandContext, "storage">,
): Promise<EnvironmentSetupApproval> {
  const worktreePath = localSetupWorktree(environment);
  const project = await context.storage.getProject(environment.projectId);
  const repoConfig = await context.storage.getRepositoryConfig(environment.projectId);
  const commands = await readSetupLocalCommands(worktreePath);
  return {
    environmentId: environment.id,
    projectId: environment.projectId,
    hash: setupCommandsHash(commands),
    commands,
    defaultBranch: repoConfig.defaultBranch,
    defaultBranchCommands: project?.localPath
      ? await readDefaultBranchSetupCommands(project.localPath, repoConfig.defaultBranch)
      : null,
    approvalRequired: environment.setupApprovalRequired === true,
  };
}

/** The worktree whose setup an approval is about; only local environments have one. */
export function localSetupWorktree(environment: Environment): string {
  if (environment.environmentType !== "local" || environment.projectHome === true) {
    throw new Error("Only a local environment's setup commands need approval");
  }
  if (!environment.worktreePath) {
    throw new Error(`Local environment worktree is not available: ${environment.id}`);
  }
  return environment.worktreePath;
}
