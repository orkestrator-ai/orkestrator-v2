import {
  createEnvironment,
  pathExists,
  runCommand,
  sanitizeEnvironmentName,
} from "./commands-dependencies.js";
import type { Environment, EnvironmentType, Project } from "./commands-dependencies.js";
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

export interface EnvironmentForkBase {
  branch: string;
  commit: string;
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
    if (!(await isContainerRunning(environment.containerId))) {
      throw new Error("Start this environment before forking so its current work can be copied");
    }
    const commit = await readContainerHeadCommit(environment.containerId);
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
  if (recorded && /^[0-9a-f]{40}$/i.test(recorded)) {
    return { branch, commit: recorded };
  }

  throw new Error("Cannot determine this environment's current commit");
}

export async function assertForkCommitUsable(
  project: Pick<Project, "localPath">,
  commit: string,
  environmentType: EnvironmentType,
): Promise<void> {
  if (environmentType !== "local") {
    if (!project.localPath) return;
    const containing = await runCommand(
      "git",
      ["for-each-ref", `--contains=${commit}`, "--format=%(refname)", "refs/remotes"],
      { cwd: project.localPath, timeoutMs: 10_000 },
    ).catch(() => ({ stdout: "" }));
    if (containing.stdout.split("\n").some((ref) => ref && !ref.endsWith("/HEAD"))) return;
    throw new Error(
      "Fork container requires the current commit to be published to a remote. Push the branch, or choose Fork local.",
    );
  }

  if (!project.localPath) {
    throw new Error("Project has no local path - cannot create a local worktree");
  }
  if (await gitRefExists(project.localPath, commit)) return;
  throw new Error(
    "This environment's current commit is not available in the project checkout. Push the branch or fork after the commit is present locally.",
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
    entryPort: repoConfig.entryPort,
  });
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
