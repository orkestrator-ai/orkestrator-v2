/**
 * `push-branch` (plan P2.7): pushes a `workspace@1` commit to the run's
 * branch on origin, with Ship's push rules made backend code (D12):
 *
 * - a plain push, so a branch that moved on the remote is refused rather
 *   than overwritten;
 * - `--force-with-lease`, leased on the remote-tracking ref, only when the
 *   run's newest code rewind dropped commits the upstream already had and no
 *   push has completed since (`graphForcePushRewind`; item 210 records the
 *   rewind's upstream facts on `GraphRewind.code`);
 * - once per run, branch and commit (effect `push:<branch>:<sha>`); after a
 *   crash the remote is asked whether it already has the commit.
 *
 * `open-pull-request` pushes through {@link pushGraphCommit} too, so a commit
 * `push-branch` already pushed is not pushed again.
 */
import { graphForcePushRewind } from "@orkestrator/protocol/graphs/system-actions";
import {
  GraphSystemActionError,
  graphProviderError,
  type GraphSystemActionContext,
  type GraphSystemActionHandler,
} from "./graph-system-action.js";
import type { Environment } from "./models.js";

/** The payload of `workspace@1`. */
export interface GraphWorkspaceValue {
  branch: string;
  headRef: string;
  baseRef: string | null;
}

const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const SAFE_BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;

/** The data a completed push records (effect `push:<branch>:<sha>`). */
export interface GraphPushRecord extends Record<string, unknown> {
  pushedAt: string;
  /** The remote already had the commit. */
  alreadyPushed?: boolean;
  /** The code rewind this push forced over (consumes it). */
  forcedForRewind?: string;
}

export function graphPushEffectKey(branch: string, headRef: string): string {
  return `push:${branch}:${headRef}`;
}

/** Rewinds a completed forced push has already consumed. */
async function consumedRewinds(ctx: GraphSystemActionContext): Promise<Set<string>> {
  const effects = await ctx.deps.storage.graphEffects.listGraphEffects(ctx.run.id);
  return new Set(
    effects.flatMap((effect) =>
      effect.state === "done" && typeof effect.data?.forcedForRewind === "string"
        ? [effect.data.forcedForRewind]
        : [],
    ),
  );
}

async function remoteHead(
  ctx: GraphSystemActionContext,
  environment: Environment,
  branch: string,
): Promise<string | null> {
  let output: string;
  try {
    output = await ctx.deps.shell.remoteGit(
      environment,
      "ls-remote",
      ["origin", `refs/heads/${branch}`],
      { signal: ctx.signal },
    );
  } catch (error) {
    throw graphProviderError("Could not read the remote branch", error);
  }
  const sha = output.trim().split(/\s+/)[0] ?? "";
  return COMMIT.test(sha) ? sha : null;
}

async function trackingRef(
  ctx: GraphSystemActionContext,
  environment: Environment,
  branch: string,
): Promise<string | null> {
  try {
    const sha = (
      await ctx.deps.shell.git(environment, [
        "rev-parse",
        "--verify",
        `refs/remotes/origin/${branch}`,
      ])
    ).trim();
    return COMMIT.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** Validates a `workspace@1` against the run's environment. */
export async function checkGraphWorkspace(
  ctx: GraphSystemActionContext,
  workspace: GraphWorkspaceValue,
): Promise<Environment> {
  const environment = await ctx.environment();
  if (!SAFE_BRANCH.test(workspace.branch)) {
    throw new GraphSystemActionError("The workspace names an invalid branch");
  }
  if (workspace.branch !== environment.branch) {
    throw new GraphSystemActionError(
      `The workspace is on branch ${workspace.branch}, not the run's branch ${environment.branch}`,
    );
  }
  if (!COMMIT.test(workspace.headRef)) {
    throw new GraphSystemActionError("The workspace's headRef is not a full commit SHA");
  }
  try {
    await ctx.deps.shell.git(environment, ["cat-file", "-e", `${workspace.headRef}^{commit}`]);
  } catch {
    throw new GraphSystemActionError(
      `Commit ${workspace.headRef.slice(0, 12)} is not in the environment's repository`,
    );
  }
  return environment;
}

/** The remote has the commit: a due rewind's divergence is resolved too. */
function alreadyPushed(ctx: GraphSystemActionContext, rewindId?: string): GraphPushRecord {
  return {
    pushedAt: ctx.now().toISOString(),
    alreadyPushed: true,
    ...(rewindId ? { forcedForRewind: rewindId } : {}),
  };
}

/**
 * Pushes `workspace.headRef` to `workspace.branch` on origin at most once per
 * run, branch and commit; force-with-lease only after a code rewind.
 */
export async function pushGraphCommit(
  ctx: GraphSystemActionContext,
  workspace: GraphWorkspaceValue,
): Promise<GraphPushRecord> {
  const environment = await checkGraphWorkspace(ctx, workspace);
  const { branch, headRef } = workspace;
  const refspec = `${headRef}:refs/heads/${branch}`;
  return ctx.effect<GraphPushRecord>(
    graphPushEffectKey(branch, headRef),
    async () => {
      const remote = await remoteHead(ctx, environment, branch);
      const force = graphForcePushRewind(ctx.run.rewinds, await consumedRewinds(ctx));
      if (remote === headRef) return alreadyPushed(ctx, force?.rewindId);
      const lease = force ? ((await trackingRef(ctx, environment, branch)) ?? remote) : null;
      const args = force
        ? [
            lease ? `--force-with-lease=refs/heads/${branch}:${lease}` : "--force-with-lease",
            "origin",
            refspec,
          ]
        : ["origin", refspec];
      try {
        await ctx.deps.shell.remoteGit(environment, "push", args, { signal: ctx.signal });
      } catch (error) {
        const line = error instanceof Error ? error.message : "";
        if (!force && /non-fast-forward|fetch first|\[rejected\]/i.test(line)) {
          throw new GraphSystemActionError(
            `The remote branch ${branch} has commits this run does not have; a branch is force-pushed only after a code rewind`,
          );
        }
        if (force && /stale info|\[rejected\]/i.test(line)) {
          throw new GraphSystemActionError(
            `The lease on ${branch} was refused: the remote branch moved since the rewind`,
          );
        }
        throw graphProviderError(`Could not push ${branch}`, error);
      }
      // Best effort: later rewinds read `@{upstream}` (P2.10), as the pipeline's do.
      await ctx.deps.shell
        .git(environment, ["branch", `--set-upstream-to=origin/${branch}`, branch])
        .catch(() => undefined);
      return {
        pushedAt: ctx.now().toISOString(),
        ...(force ? { forcedForRewind: force.rewindId } : {}),
      };
    },
    {
      probe: async () => {
        if ((await remoteHead(ctx, environment, branch)) !== headRef) return undefined;
        const force = graphForcePushRewind(ctx.run.rewinds, await consumedRewinds(ctx));
        return alreadyPushed(ctx, force?.rewindId);
      },
    },
  );
}

export const pushBranchAction: GraphSystemActionHandler = {
  action: "push-branch",
  async run(ctx) {
    const workspace = await ctx.requireInput<GraphWorkspaceValue>("workspace@1");
    await pushGraphCommit(ctx, workspace);
    await ctx.output("workspace@1", workspace, {
      workspace: {
        headRef: workspace.headRef,
        ...(workspace.baseRef ? { baseRef: workspace.baseRef } : {}),
      },
    });
  },
};
