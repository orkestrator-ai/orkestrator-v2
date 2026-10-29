/**
 * Commands behind the Changes tab's "Compare against" menu: list the branches
 * and commits an environment's checkout can compare against, and save or clear
 * the user's choice (`diffBaseOverride`).
 */

import type { DiffBaseBranch, DiffBaseCommit } from "@orkestrator/protocol/diff-stats";
import type { CommandContext } from "./commands-context.js";
import type { CommandRegistrar } from "./commands-registry-types.js";
import { toClientEnvironment } from "./commands-terminal.js";
import { asString, assertOnlyKeys } from "./commands-validation.js";
import {
  DEFAULT_DIFF_BASE_COMMITS,
  diffBaseGitForEnvironment,
  listDiffBaseBranches,
  listDiffBaseCommits,
  resolveDiffBaseOverride,
  type DiffBaseGit,
} from "./diff-base-override.js";
import type { Environment } from "./models.js";

export interface DiffBaseCommandOptions {
  /** Test seam: the git runner for an environment's checkout. */
  gitFor?: (environment: Environment) => DiffBaseGit;
}

async function requireEnvironment(context: CommandContext, id: unknown): Promise<Environment> {
  const environmentId = asString(id, "environmentId");
  const environment = await context.storage.getEnvironment(environmentId);
  if (!environment) throw new Error(`Environment not found: ${environmentId}`);
  return environment;
}

export function registerDiffBaseCommands(
  register: CommandRegistrar,
  options: DiffBaseCommandOptions = {},
): void {
  const gitFor = options.gitFor ?? diffBaseGitForEnvironment;

  register("list_environment_diff_base_branches", async (args, context) => {
    assertOnlyKeys(args, ["environmentId"], "arguments");
    const environment = await requireEnvironment(context, args.environmentId);
    return (await listDiffBaseBranches(gitFor(environment))) satisfies DiffBaseBranch[];
  });

  register("list_environment_diff_base_commits", async (args, context) => {
    assertOnlyKeys(args, ["environmentId", "ref", "limit"], "arguments");
    const environment = await requireEnvironment(context, args.environmentId);
    const limit =
      typeof args.limit === "number" && Number.isSafeInteger(args.limit) && args.limit > 0
        ? args.limit
        : DEFAULT_DIFF_BASE_COMMITS;
    return (await listDiffBaseCommits(
      gitFor(environment),
      asString(args.ref, "ref"),
      limit,
    )) satisfies DiffBaseCommit[];
  });

  /** `{ ref, commit }` sets the base; `ref` and `commit` both null clears it. */
  register("set_environment_diff_base", async (args, context) => {
    assertOnlyKeys(args, ["environmentId", "ref", "commit"], "arguments");
    const environment = await requireEnvironment(context, args.environmentId);
    const clear = args.ref == null && args.commit == null;
    const diffBaseOverride = clear
      ? null
      : await resolveDiffBaseOverride(gitFor(environment), { ref: args.ref, commit: args.commit });
    const updated = await context.storage.updateEnvironment(environment.id, { diffBaseOverride });
    // Retarget the environment's scans at the new comparison ref.
    await context.runtime.diffStats.sync(context);
    context.runtime.diffStats.service.refresh(environment.id);
    return toClientEnvironment(updated);
  });
}
