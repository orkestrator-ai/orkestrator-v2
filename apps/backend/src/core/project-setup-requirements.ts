import type { CommandContext } from "./commands-context.js";
import { readDefaultBranchConfigText, type GitBlobReader } from "./setup-approval.js";

/**
 * What a project's `orkestrator-ai.json` asks of a new container, read before
 * one is created so a launcher can say so (`get_project_setup_requirements`).
 *
 * Advisory only: it reads the default branch from this machine's checkout
 * without fetching, so it can lag the remote. The container's own
 * `workspace-setup.sh` stays the authority on what runs.
 */

/**
 * How many root steps `orkestrator-ai.json` text names, counted exactly as
 * `project_root_step_count` in `docker/workspace-setup.sh` counts them: a
 * non-empty string is one, an array counts its entries that are neither null
 * nor `""`, null/false/absent is none, and any other value is one. Text that
 * does not parse names none, as the script's `jq` failure does.
 */
export function countRootSetupSteps(text: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 0;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return 0;
  const root = (parsed as { root?: unknown }).root;
  if (Array.isArray(root)) return root.filter((step) => step !== null && step !== "").length;
  if (typeof root === "string") return root === "" ? 0 : 1;
  if (root === undefined || root === null || root === false) return 0;
  return 1;
}

export type ProjectSetupRequirements = {
  /**
   * Root steps on the default branch; `null` when this machine cannot tell
   * (no checkout, no such branch, or an unreadable file).
   */
  rootSteps: number | null;
};

export async function readProjectSetupRequirements(
  projectId: string,
  context: Pick<CommandContext, "storage">,
  readBlob?: GitBlobReader,
): Promise<ProjectSetupRequirements> {
  const project = await context.storage.getProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);
  if (!project.localPath) return { rootSteps: null };
  const { defaultBranch } = await context.storage.getRepositoryConfig(projectId);
  const text = await readDefaultBranchConfigText(project.localPath, defaultBranch, readBlob);
  if (text === null) return { rootSteps: null };
  return { rootSteps: text.trim() ? countRootSetupSteps(text) : 0 };
}
