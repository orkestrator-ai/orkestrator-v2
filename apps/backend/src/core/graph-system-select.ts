/**
 * `select-workspace` (item 403, D3): picks one isolated branch's commit and
 * moves the run's branch to it.
 *
 * - **Candidates** are the `list<workspace@1>` fan-in of a node with
 *   `isolation: "worktree"`, each verified; the producing activation names
 *   its branch key. A failure marker (`error@1`, kept by `includeFailures`)
 *   is a candidate that cannot win.
 * - **The choice** is the `decision@1` input's `choice`, matched by
 *   `resolveGraphSelectChoice` (branch key, its last part, or the Git
 *   branch). `fallback: "first"` takes the first successful branch when it
 *   names none.
 * - **The move**, journaled once per slot and chosen commit (effect
 *   `select-workspace:<slot>:<sha>`): with the run's checkout free of
 *   uncommitted tracked changes and on the run's branch, a fast-forward
 *   (`git merge --ff-only`). A branch that moved past the candidates' base
 *   is refused (an agent merge is the way to combine). The one exception: a
 *   HEAD that an earlier select of the same slot put there (an upstream
 *   restart reran the branches) is reset to the new choice, its old tip kept
 *   under `refs/orkestrator-graph-backup/<run>/<sha>`.
 * - **Cleanup**: every candidate's worktree and branch is removed (best
 *   effort; the run's end removes what is left).
 *
 * The output `workspace@1` is the chosen commit on the run's branch.
 */
import {
  GRAPH_COMMIT_PATTERN,
  graphBranchWorktreePath,
  graphRunBranchRefPrefix,
  resolveGraphSelectChoice,
  type GraphArtifact,
  type GraphSelectCandidate,
} from "@orkestrator/protocol/graphs/run";
import type { GraphSelectFallback } from "@orkestrator/protocol/graphs/system-actions";
import { retryGitWithoutFsmonitorOnTimeout } from "./git-fsmonitor.js";
import {
  GraphSystemActionError,
  graphProviderError,
  type GraphSystemActionContext,
  type GraphSystemActionHandler,
} from "./graph-system-action.js";
import type { GraphWorkspaceValue } from "./graph-system-push.js";
import type { Environment } from "./models.js";

/** What a completed select records (effect `select-workspace:<slot>:<sha>`). */
export interface GraphSelectRecord extends Record<string, unknown> {
  headRef: string;
  /** The run branch's tip before the move. */
  previous: string;
  method: "fast-forward" | "reset" | "unchanged";
  branchKey: string | null;
  backupRef?: string;
  selectedAt: string;
}

interface Candidate extends GraphSelectCandidate {
  artifact: GraphArtifact;
  nodeId?: string;
  iteration?: number;
}

/** The candidates in fan-in order, each with its producing branch. */
async function candidates(ctx: GraphSystemActionContext): Promise<Candidate[]> {
  const activations = new Map(
    ctx.run.activations.map((activation) => [activation.key, activation]),
  );
  const prefix = graphRunBranchRefPrefix(ctx.run.id);
  const result: Candidate[] = [];
  for (const artifact of await ctx.inputList("list<workspace@1>")) {
    const producer = activations.get(artifact.producer.activation);
    const value = ("value" in artifact.body ? artifact.body.value : undefined) as
      Partial<GraphWorkspaceValue> | undefined;
    const usable =
      artifact.type === "workspace@1" &&
      typeof value?.branch === "string" &&
      value.branch.startsWith(prefix) &&
      typeof value.headRef === "string" &&
      GRAPH_COMMIT_PATTERN.test(value.headRef);
    result.push({
      artifact,
      ...(producer?.branchKey !== undefined ? { branchKey: producer.branchKey } : {}),
      ...(producer ? { nodeId: producer.nodeId, iteration: producer.iteration } : {}),
      branch: typeof value?.branch === "string" ? value.branch : "",
      headRef: typeof value?.headRef === "string" ? value.headRef : "",
      usable,
    });
  }
  return result;
}

async function git(
  ctx: GraphSystemActionContext,
  environment: Environment,
  args: string[],
): Promise<string> {
  return ctx.deps.shell.git(environment, args, { signal: ctx.signal });
}

async function head(ctx: GraphSystemActionContext, environment: Environment): Promise<string> {
  try {
    return (await git(ctx, environment, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
  } catch (error) {
    throw graphProviderError("Could not read the run's branch", error);
  }
}

/** Commits earlier attempts of this slot moved the run's branch to. */
async function earlierSelections(ctx: GraphSystemActionContext): Promise<Set<string>> {
  const prefix = `${ctx.slotKey()}:`;
  const effects = await ctx.deps.storage.graphEffects.listGraphEffects(ctx.run.id);
  return new Set(
    effects.flatMap((effect) =>
      effect.key.startsWith(prefix) &&
      effect.state === "done" &&
      typeof effect.data?.headRef === "string"
        ? [effect.data.headRef]
        : [],
    ),
  );
}

/** Moves the run's branch to `chosen` (the journaled effect). */
async function moveBranch(
  ctx: GraphSystemActionContext,
  environment: Environment,
  chosen: Candidate,
): Promise<GraphSelectRecord> {
  const current = (
    await git(ctx, environment, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")
  ).trim();
  if (current !== environment.branch) {
    throw new GraphSystemActionError(
      `The run's checkout is on ${current || "a detached HEAD"}, not the run's branch ${environment.branch}`,
    );
  }
  const dirty = (
    await retryGitWithoutFsmonitorOnTimeout(
      ["status", "--porcelain", "--untracked-files=no"],
      (args) => git(ctx, environment, args),
      ctx.signal,
    )
  ).trim();
  if (dirty.length > 0) {
    throw new GraphSystemActionError(
      "The run's checkout has uncommitted changes; commit or discard them before selecting a branch",
    );
  }
  try {
    await git(ctx, environment, ["cat-file", "-e", `${chosen.headRef}^{commit}`]);
  } catch {
    throw new GraphSystemActionError(
      `Commit ${chosen.headRef.slice(0, 12)} is not in the environment's repository`,
    );
  }
  const previous = await head(ctx, environment);
  const record = (method: GraphSelectRecord["method"], backupRef?: string) => ({
    headRef: chosen.headRef,
    previous,
    method,
    branchKey: chosen.branchKey ?? null,
    ...(backupRef ? { backupRef } : {}),
    selectedAt: ctx.now().toISOString(),
  });
  if (previous === chosen.headRef) return record("unchanged");
  const fastForward = await git(ctx, environment, [
    "merge-base",
    "--is-ancestor",
    previous,
    chosen.headRef,
  ])
    .then(() => true)
    .catch(() => false);
  if (fastForward) {
    try {
      await git(ctx, environment, ["merge", "--ff-only", "--quiet", chosen.headRef]);
    } catch (error) {
      throw graphProviderError("Could not fast-forward the run's branch", error);
    }
    return record("fast-forward");
  }
  if (!(await earlierSelections(ctx)).has(previous)) {
    throw new GraphSystemActionError(
      `The run's branch moved past the branches' base (it is at ${previous.slice(0, 12)}); select only moves it forward. Combine the work with an agent merge instead.`,
    );
  }
  const backupRef = `refs/orkestrator-graph-backup/${ctx.run.id}/${previous}`;
  try {
    await git(ctx, environment, ["update-ref", backupRef, previous]);
    await git(ctx, environment, ["reset", "--hard", "--quiet", chosen.headRef]);
  } catch (error) {
    throw graphProviderError("Could not move the run's branch to the new choice", error);
  }
  return record("reset", backupRef);
}

/** Removes every candidate's worktree and branch (best effort). */
async function cleanUp(
  ctx: GraphSystemActionContext,
  environment: Environment,
  list: readonly Candidate[],
): Promise<void> {
  const worktrees = ctx.deps.branchWorktrees;
  if (!worktrees) return;
  const paths = list.flatMap((candidate) =>
    candidate.nodeId !== undefined &&
    candidate.iteration !== undefined &&
    candidate.branchKey !== undefined
      ? [
          graphBranchWorktreePath(ctx.run.id, {
            nodeId: candidate.nodeId,
            iteration: candidate.iteration,
            branchKey: candidate.branchKey,
          }),
        ]
      : [],
  );
  const branches = list.flatMap((candidate) => (candidate.usable ? [candidate.branch] : []));
  await worktrees.removeWorktrees(environment, paths).catch(() => undefined);
  await worktrees.deleteBranches(environment, ctx.run.id, branches).catch(() => undefined);
}

export const selectWorkspaceAction: GraphSystemActionHandler = {
  action: "select-workspace",
  async run(ctx) {
    const list = await candidates(ctx);
    if (list.length === 0) throw new GraphSystemActionError("There are no candidate branches");
    const decision = await ctx.requireInput<{ choice?: unknown }>("decision@1");
    const resolved = resolveGraphSelectChoice(
      list,
      decision.choice,
      (ctx.params.fallback as GraphSelectFallback | undefined) ?? "fail",
    );
    if (!resolved.ok) throw new GraphSystemActionError(resolved.message, "invalid-result");
    const chosen = list[resolved.index]!;
    const environment = await ctx.environment();
    ctx.throwIfAborted();
    const selected = await ctx.effect(
      ctx.slotKey(chosen.headRef),
      () => moveBranch(ctx, environment, chosen),
      {
        data: { headRef: chosen.headRef },
        probe: async (intent) => {
          // The move happened when the branch is already at the chosen commit.
          const now = await head(ctx, environment).catch(() => "");
          return now === chosen.headRef
            ? {
                headRef: chosen.headRef,
                previous: typeof intent.data?.previous === "string" ? intent.data.previous : now,
                method: "unchanged",
                branchKey: chosen.branchKey ?? null,
                selectedAt: ctx.now().toISOString(),
              }
            : undefined;
        },
      },
    );
    await cleanUp(ctx, environment, list);
    const workspace: GraphWorkspaceValue = {
      branch: environment.branch,
      headRef: selected.headRef,
      baseRef: selected.previous,
    };
    await ctx.output("workspace@1", workspace, {
      workspace: { headRef: selected.headRef, baseRef: selected.previous },
    });
  },
};
