import type { EnvironmentLifecycleRemedy } from "@orkestrator/protocol/contract/domains/environments";
import {
  ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES,
  isGitSshUnreachableMessage,
} from "./commands-error-text.js";
import { detectHttpsRemedy } from "./git-ssh-transport.js";
import type { Environment, Project } from "./models.js";
import type { runCommand } from "./shell.js";

/**
 * The fix to offer beside a failed start, checked before it is offered. Only a
 * local environment's start fetches through the project's own checkout, so
 * only that start can be fixed by switching its `origin` to HTTPS. A timeout
 * is included: on Linux an SSH connect to a dropped port outlasts the fetch
 * deadline, so the cause never reaches the output. Never throws: a failed
 * check offers nothing rather than hiding the start's own failure.
 */
export async function startFailureRemedy(
  environment: Pick<Environment, "environmentType" | "projectId">,
  lifecycleError: string,
  storage: { getProject(projectId: string): Promise<Project | null | undefined> },
  run?: typeof runCommand,
): Promise<EnvironmentLifecycleRemedy | null> {
  if (environment.environmentType !== "local") return null;
  if (
    !isGitSshUnreachableMessage(lifecycleError) &&
    lifecycleError !== ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.gitRemoteTimedOut
  ) {
    return null;
  }
  try {
    const project = await storage.getProject(environment.projectId);
    if (!project?.localPath) return null;
    return await detectHttpsRemedy(project.localPath, run);
  } catch {
    return null;
  }
}
