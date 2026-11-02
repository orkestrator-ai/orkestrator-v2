/**
 * Whether a `push-no-pr` Ship really pushed: the environment's current branch
 * and commit against origin's copy of that branch. The pull request path learns
 * this from the pull request; a push has nothing else to show for it.
 */
import type { BranchPushState } from "./build-pipeline-context.js";
import type { GraphEnvironmentShell } from "./graph-system-environment.js";
import type { Environment } from "./models.js";

export async function readEnvironmentBranchPushState(
  storage: { getEnvironment: (id: string) => Promise<Environment | null> },
  shell: Pick<GraphEnvironmentShell, "git" | "remoteGit">,
  environmentId: string,
): Promise<BranchPushState> {
  const environment = await storage.getEnvironment(environmentId);
  if (!environment) throw new Error("Build environment no longer exists");
  const head = (await shell.git(environment, ["rev-parse", "HEAD"])).trim();
  const current = (await shell.git(environment, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  // A detached HEAD names no branch; the environment still records its own.
  const branch = current && current !== "HEAD" ? current : environment.branch;
  const output = await shell.remoteGit(environment, "ls-remote", [
    "origin",
    `refs/heads/${branch}`,
  ]);
  return { branch, head, remoteHead: output.trim().split(/\s+/)[0] || null };
}
