/**
 * Commands behind the Changes tab's "Compare against" menu: list the branches
 * and commits an environment's checkout can compare against, and save or clear
 * the user's choice (`diffBaseOverride`).
 */

import type { AnyCommandDef } from "@orkestrator/protocol/contract/command";
import {
  listEnvironmentDiffBaseBranchesCommand,
  listEnvironmentDiffBaseCommitsCommand,
  setEnvironmentDiffBaseCommand,
} from "@orkestrator/protocol/contract/domains/git";
import type { DiffBaseBranch, DiffBaseCommit } from "@orkestrator/protocol/diff-stats";
import type { CommandContext } from "./commands-context.js";
import { ASYNC_HANDLER } from "./commands-registry-async-decode.js";
import type { CommandRegistrar, DefinedCommandHandler } from "./commands-registry-types.js";
import { toClientEnvironment } from "./commands-terminal.js";
import { asString } from "./commands-validation.js";
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

/**
 * Registered with their `git` definitions (plan item 7006). The three
 * commands were strict (`assertOnlyKeys`) and now drop unknown keys; the
 * handlers are `async`, so a refused argument is still a rejection.
 */
export function registerDiffBaseCommands(
  registerCommand: CommandRegistrar,
  options: DiffBaseCommandOptions = {},
): void {
  const register = <C extends AnyCommandDef>(def: C, handler: DefinedCommandHandler<C>) =>
    registerCommand(def, handler, ASYNC_HANDLER);
  const gitFor = options.gitFor ?? diffBaseGitForEnvironment;

  register(listEnvironmentDiffBaseBranchesCommand, async (args, context) => {
    const environment = await requireEnvironment(context, args.environmentId);
    return (await listDiffBaseBranches(gitFor(environment))) satisfies DiffBaseBranch[];
  });

  register(listEnvironmentDiffBaseCommitsCommand, async (args, context) => {
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
  register(setEnvironmentDiffBaseCommand, async (args, context) => {
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
