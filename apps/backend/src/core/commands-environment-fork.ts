import {
  CommandFailedError,
  createEnvironment,
  pathExists,
  runCommand,
  sanitizeEnvironmentName,
} from "./commands-dependencies.js";
import type { Environment, EnvironmentType, Project } from "./commands-dependencies.js";
import type { NetworkAccessMode } from "./models.js";
import { isContainerRunning } from "./commands-container-exec.js";
import {
  parseHeadCommit,
  readContainerHeadCommit,
  readLocalHeadCommit,
} from "./commands-local-server-lifecycle.js";
import { gitRefExists } from "./commands-files.js";
import {
  allocateEnvironmentBranchName,
  makeUniqueEnvironmentSlug,
  validateGitRefName,
} from "./commands-agent-support.js";
import type { CommandContext } from "./commands-context.js";
import { toClientEnvironment } from "./commands-terminal.js";

const GIT_REMOTE_QUERY_TIMEOUT_MS = 30_000;
const GIT_FETCH_TIMEOUT_MS = 120_000;
const GIT_REF_TIMEOUT_MS = 10_000;
const FULL_COMMIT_RE = /^[0-9a-f]{40}$/i;

function gitNoPromptEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: "0" };
}

export interface EnvironmentForkBase {
  branch: string;
  commit: string;
}

/**
 * Test seam for container HEAD resolution. Production uses the live Docker
 * helpers; backend tests replace these to exercise the containerized branch
 * without a daemon.
 */
export const environmentForkHooks = {
  isContainerRunning,
  readContainerHeadCommit,
};

export function resolveForkNetworkAccessMode(
  source: Pick<Environment, "environmentType" | "networkAccessMode">,
  targetType: EnvironmentType,
): NetworkAccessMode {
  if (source.environmentType === targetType) return source.networkAccessMode;
  if (targetType === "containerized") return "restricted";
  return source.networkAccessMode;
}

/**
 * Current committed work on an environment, not the project's default branch.
 *
 * A live checkout wins. A worktree or running container is the only place the
 * environment's later commits (and not just its original baseline) are known.
 * Fallbacks are only used when that checkout has never existed.
 */
export async function resolveEnvironmentForkBase(
  environment: Environment,
  project: Pick<Project, "localPath">,
): Promise<EnvironmentForkBase> {
  const branch = environment.branch.trim();
  if (!branch) {
    throw new Error("Environment has no branch to fork from");
  }

  if (environment.environmentType === "local" && environment.worktreePath) {
    if (await pathExists(environment.worktreePath)) {
      return { branch, commit: await readLocalHeadCommit(environment.worktreePath) };
    }
  }

  if (environment.environmentType === "containerized" && environment.containerId) {
    if (!(await environmentForkHooks.isContainerRunning(environment.containerId))) {
      throw new Error("Start this environment before forking so its current work can be copied");
    }
    const commit = await environmentForkHooks.readContainerHeadCommit(environment.containerId);
    if (!commit) {
      throw new Error(`Could not read HEAD from environment ${environment.id}`);
    }
    return { branch, commit };
  }

  if (project.localPath) {
    const ref = validateGitRefName(branch, "environment branch");
    if (await gitRefExists(project.localPath, ref)) {
      const { stdout } = await runCommand(
        "git",
        ["-C", project.localPath, "rev-parse", "--verify", `${ref}^{commit}`],
        { timeoutMs: 30_000 },
      );
      const commit = parseHeadCommit(stdout);
      if (commit) return { branch, commit };
    }
  }

  const recorded = environment.createdFromCommit ?? environment.delegationBaseCommit;
  if (recorded && FULL_COMMIT_RE.test(recorded)) {
    return { branch, commit: recorded };
  }

  throw new Error("Cannot determine this environment's current commit");
}

function unpublishedContainerForkError(): Error {
  return new Error(
    "Fork container requires the current commit to be published to a remote. Push the branch, or choose Fork local.",
  );
}

function couldNotVerifyPublishedError(detail: string): Error {
  return new Error(`Could not verify that the current commit is published to a remote. ${detail}`);
}

function lsRemoteHasCommit(stdout: string, commit: string): boolean {
  const needle = commit.toLowerCase();
  return stdout.split("\n").some((line) => {
    const sha = line.trim().split(/\s+/)[0]?.toLowerCase();
    return sha === needle;
  });
}

function remoteRefsContainCommit(stdout: string): boolean {
  return stdout.split("\n").some((ref) => ref && !ref.endsWith("/HEAD"));
}

async function lsRemoteCommitTips(remoteUrl: string): Promise<string> {
  const { stdout } = await runCommand("git", ["ls-remote", remoteUrl], {
    timeoutMs: GIT_REMOTE_QUERY_TIMEOUT_MS,
    env: gitNoPromptEnv(),
  });
  return stdout;
}

async function fetchProjectRemotes(localPath: string, remoteUrl?: string): Promise<void> {
  try {
    await runCommand("git", ["fetch", "--prune", "origin"], {
      cwd: localPath,
      timeoutMs: GIT_FETCH_TIMEOUT_MS,
      env: gitNoPromptEnv(),
    });
  } catch (error) {
    if (!remoteUrl) throw error;
    await runCommand("git", ["fetch", "--prune", remoteUrl], {
      cwd: localPath,
      timeoutMs: GIT_FETCH_TIMEOUT_MS,
      env: gitNoPromptEnv(),
    });
  }
}

async function localRemotesContainCommit(localPath: string, commit: string): Promise<boolean> {
  if (!(await gitRefExists(localPath, commit))) return false;
  try {
    const containing = await runCommand(
      "git",
      ["for-each-ref", `--contains=${commit}`, "--format=%(refname)", "refs/remotes"],
      { cwd: localPath, timeoutMs: GIT_REF_TIMEOUT_MS },
    );
    return remoteRefsContainCommit(containing.stdout);
  } catch (error) {
    if (error instanceof CommandFailedError && (error.timedOut || error.executableMissing)) {
      throw couldNotVerifyPublishedError("Fetch the project checkout and try again.");
    }
    throw couldNotVerifyPublishedError("Fetch the project checkout and try again.");
  }
}

async function assertCommitPublishedToRemote(
  project: Pick<Project, "localPath" | "gitUrl">,
  commit: string,
): Promise<void> {
  const remoteUrl = project.gitUrl?.trim() || undefined;
  if (remoteUrl) {
    try {
      if (lsRemoteHasCommit(await lsRemoteCommitTips(remoteUrl), commit)) return;
    } catch {
      if (!project.localPath) {
        throw couldNotVerifyPublishedError("Check the project's remote URL and try again.");
      }
    }
  } else if (!project.localPath) {
    throw new Error(
      "Fork container requires a project remote so the current commit can be verified. Add a git URL, or choose Fork local.",
    );
  }

  if (!project.localPath) throw unpublishedContainerForkError();

  try {
    await fetchProjectRemotes(project.localPath, remoteUrl);
  } catch {
    throw couldNotVerifyPublishedError("Fetch the project checkout and try again.");
  }

  if (await localRemotesContainCommit(project.localPath, commit)) return;
  throw unpublishedContainerForkError();
}

export async function assertForkCommitUsable(
  project: Pick<Project, "localPath" | "gitUrl">,
  commit: string,
  environmentType: EnvironmentType,
): Promise<void> {
  if (!FULL_COMMIT_RE.test(commit)) {
    throw new Error("Cannot determine this environment's current commit");
  }

  if (environmentType !== "local") {
    await assertCommitPublishedToRemote(project, commit);
    return;
  }

  if (!project.localPath) {
    throw new Error("Project has no local path - cannot create a local worktree");
  }
  if (await gitRefExists(project.localPath, commit)) return;

  try {
    await fetchProjectRemotes(project.localPath, project.gitUrl?.trim() || undefined);
  } catch {
    throw new Error(
      "Could not verify this environment's current commit in the project checkout. Fetch the project checkout and try again.",
    );
  }
  if (await gitRefExists(project.localPath, commit)) return;
  throw new Error(
    "This environment's current commit is not available in the project checkout. Fetch the project checkout, or push the branch and fork after the commit is present locally.",
  );
}

export async function forkEnvironmentRecord(
  source: Environment,
  environmentType: EnvironmentType,
  context: CommandContext,
): Promise<Environment> {
  const { storage } = context;
  const project = await storage.getProject(source.projectId);
  if (!project) throw new Error(`Project not found: ${source.projectId}`);
  if (environmentType === "local" && !project.localPath) {
    throw new Error("Project has no local path - cannot create a local worktree");
  }

  const base = await resolveEnvironmentForkBase(source, project);
  await assertForkCommitUsable(project, base.commit, environmentType);

  const repoConfig = await storage.getRepositoryConfig(project.id);
  const existingEnvironments = await storage.getEnvironmentsByProject(project.id);
  const uniqueName = makeUniqueEnvironmentSlug(
    `${sanitizeEnvironmentName(source.name)}-fork`,
    existingEnvironments,
  );
  const env = createEnvironment(project.id, {
    name: uniqueName,
    environmentType,
    entryPort: source.entryPort ?? repoConfig.entryPort,
    buildPipelineId: source.buildPipelineId,
    networkAccessMode: resolveForkNetworkAccessMode(source, environmentType),
    portMappings: source.portMappings?.map((mapping) => ({ ...mapping })),
  });
  if (source.allowedDomains) env.allowedDomains = [...source.allowedDomains];
  if (source.agentSettings) env.agentSettings = { ...source.agentSettings };
  env.branch = await allocateEnvironmentBranchName({
    name: env.name,
    environmentId: env.id,
    siblingEnvironments: existingEnvironments,
    projectPath: environmentType === "local" ? project.localPath : null,
    remoteUrl: project.gitUrl,
  });
  env.delegationBaseBranch = base.branch;
  env.delegationBaseCommit = base.commit;
  await storage.patchRepositoryConfig(project.id, {
    lastEnvironmentType: env.environmentType,
  });
  return toClientEnvironment(await storage.addEnvironment(env));
}
