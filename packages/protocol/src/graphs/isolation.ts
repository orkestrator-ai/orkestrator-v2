/**
 * Isolated branch worktrees (item 403, D3, report §6.7): the names, bounds
 * and rules every layer shares. Browser-safe.
 *
 * A replicated agent node that writes the workspace must opt into
 * `isolation: "worktree"`. Each of its activations (one branch, one
 * iteration) then writes its own Git worktree of the environment's
 * repository, created from the commit its `workspace@1` input names, on its
 * own branch:
 *
 * - worktree `.orkestrator/graph-branches/<run>/<node>/i<iteration>/<branch>`
 *   (an inlined sub-graph's `outer/inner` node id written `outer--inner`),
 *   relative to the environment root (`/workspace` in a container), inside
 *   the Git-excluded `.orkestrator/` directory;
 * - branch `orkestrator-graph/<run>/<node>/i<iteration>/<branch>`.
 *
 * For the workspace rules (the compiler's and the scheduler's) an isolated
 * writer is a *reader* of the run's own workspace: it must stay unchanged
 * while the branches work, so they never overlap a writer of it, but they may
 * run beside readers and each other. `select-workspace` then fast-forwards
 * the run's branch to one branch's commit; an agent `merge` merges several.
 */
import type { GraphActivationKeyParts } from "./run-identity.js";
import { isGraphBranchKey, isGraphRunId } from "./run-identity.js";
import { isGraphPlanId } from "./grammar.js";
import type { GraphWorkspaceAccess, GraphWorkspaceIsolation } from "./template-model.js";

export const GRAPH_ISOLATION_BOUNDS = Object.freeze({
  /** Branches an isolated node may run (the compiler's `isolation-branch-limit`). */
  maxBranches: 8,
  /**
   * Branch worktrees admitted at once on one environment, across its runs.
   * A branch over it waits (admission block `worktree-limit`).
   */
  maxLiveWorktreesPerEnvironment: 16,
});

/** Workspace-relative directory of every run's branch worktrees. */
export const GRAPH_BRANCH_WORKTREE_DIRECTORY = ".orkestrator/graph-branches";
/** Prefix of every branch an isolated activation commits on. */
export const GRAPH_BRANCH_REF_PREFIX = "orkestrator-graph";

/** What an isolated activation recorded about its worktree before dispatch. */
export interface GraphActivationWorktree {
  /** Relative to the environment root: {@link graphBranchWorktreePath}. */
  path: string;
  /** {@link graphBranchWorktreeRef}. */
  branch: string;
  /** The commit the worktree was created from (the `workspace@1` input). */
  baseRef: string;
  createdAt: string;
}

/** Whether a node runs its branches in isolated worktrees. */
export function graphNodeIsolated(node: {
  kind: string;
  isolation?: GraphWorkspaceIsolation;
}): boolean {
  return node.kind === "agent" && node.isolation === "worktree";
}

/**
 * What a node holds on the run's own workspace: an isolated writer only
 * reads it (it writes its own worktree), everything else what it declares.
 */
export function graphMainWorkspaceAccess(node: {
  kind: string;
  workspaceAccess: GraphWorkspaceAccess;
  isolation?: GraphWorkspaceIsolation;
}): GraphWorkspaceAccess {
  return graphNodeIsolated(node) && node.workspaceAccess === "write"
    ? "read"
    : node.workspaceAccess;
}

type BranchPosition = Pick<GraphActivationKeyParts, "nodeId" | "iteration"> & {
  branchKey: string;
};

/** A branch key as a path segment and ref component: `:` (not allowed in refs) becomes `_`. */
function branchSegment(branchKey: string): string {
  return branchKey.replaceAll(":", "_");
}

/**
 * A plan node id as one path segment and ref component. An inlined
 * sub-graph's node id joins graph ids with `/` (item 402); a graph id never
 * holds `--`, so `/` → `--` stays one component and is reversible
 * (`review/fix` → `review--fix`).
 */
export function graphBranchNodeSegment(nodeId: string): string {
  if (!isGraphPlanId(nodeId)) throw new Error("Invalid graph node id");
  return nodeId.replaceAll("/", "--");
}

function leaf(position: BranchPosition): string {
  const node = graphBranchNodeSegment(position.nodeId);
  if (!Number.isSafeInteger(position.iteration) || position.iteration < 1) {
    throw new Error("Invalid loop iteration");
  }
  if (!isGraphBranchKey(position.branchKey)) throw new Error("Invalid branch key");
  return `${node}/i${position.iteration}/${branchSegment(position.branchKey)}`;
}

/** `.orkestrator/graph-branches/<run>`. */
export function graphRunBranchWorktreeDirectory(runId: string): string {
  if (!isGraphRunId(runId)) throw new Error("Invalid graph run id");
  return `${GRAPH_BRANCH_WORKTREE_DIRECTORY}/${runId}`;
}

/** `orkestrator-graph/<run>/`: every branch of the run starts with it. */
export function graphRunBranchRefPrefix(runId: string): string {
  if (!isGraphRunId(runId)) throw new Error("Invalid graph run id");
  return `${GRAPH_BRANCH_REF_PREFIX}/${runId}/`;
}

/** The worktree of one branch position, relative to the environment root. */
export function graphBranchWorktreePath(runId: string, position: BranchPosition): string {
  return `${graphRunBranchWorktreeDirectory(runId)}/${leaf(position)}`;
}

/** The branch one branch position commits on. */
export function graphBranchWorktreeRef(runId: string, position: BranchPosition): string {
  return `${graphRunBranchRefPrefix(runId)}${leaf(position)}`;
}

/** The run a branch worktree path belongs to, or null when it is not one of ours. */
export function parseGraphBranchWorktreePath(value: unknown): { runId: string } | null {
  if (typeof value !== "string" || value.length > 512) return null;
  const prefix = `${GRAPH_BRANCH_WORKTREE_DIRECTORY}/`;
  if (!value.startsWith(prefix)) return null;
  const parts = value.slice(prefix.length).split("/");
  if (parts.length !== 4) return null;
  const [runId, nodeId, iteration, branch] = parts as [string, string, string, string];
  if (!isGraphRunId(runId) || !isGraphPlanId(nodeId.replaceAll("--", "/"))) return null;
  if (
    !/^i[1-9][0-9]{0,3}$/.test(iteration) ||
    !/^[A-Za-z0-9][A-Za-z0-9._+_-]{0,95}$/.test(branch)
  ) {
    return null;
  }
  return { runId };
}

// ---------------------------------------------------------------- select

/** One candidate a `select-workspace` node may choose. */
export interface GraphSelectCandidate {
  /** The producing activation's branch key (`sample.2`), when known. */
  branchKey?: string;
  /** The `workspace@1` value's branch. */
  branch: string;
  headRef: string;
  /** False for a failure marker or a candidate the select cannot use. */
  usable: boolean;
}

export type GraphSelectChoice =
  { ok: true; index: number; matched: "choice" | "fallback" } | { ok: false; message: string };

/** `panel.1+lens.tests` → `tests`; `sample.2` → `2`. */
function lastPart(branchKey: string): string {
  const axis = branchKey.split("+").at(-1)!;
  const dot = axis.indexOf(".");
  return dot < 0 ? axis : axis.slice(dot + 1);
}

/**
 * Which candidate a decision's `choice` names (item 403): its branch key
 * exactly, else the key's last part when exactly one candidate has it, else
 * its Git branch. With `fallback: "first"` a choice that names no usable
 * candidate takes the first usable one in order.
 */
export function resolveGraphSelectChoice(
  candidates: readonly GraphSelectCandidate[],
  choice: unknown,
  fallback: "fail" | "first" = "fail",
): GraphSelectChoice {
  const usable = (index: number) => candidates[index]?.usable === true;
  const fallBack = (message: string): GraphSelectChoice => {
    if (fallback === "first") {
      const index = candidates.findIndex((candidate) => candidate.usable);
      if (index >= 0) return { ok: true, index, matched: "fallback" };
      return { ok: false, message: "No candidate branch succeeded" };
    }
    return { ok: false, message };
  };
  if (typeof choice !== "string" || choice.length === 0) {
    return fallBack("The decision names no branch");
  }
  let index = candidates.findIndex((candidate) => candidate.branchKey === choice);
  if (index < 0) {
    const byPart = candidates.flatMap((candidate, at) =>
      candidate.branchKey !== undefined && lastPart(candidate.branchKey) === choice ? [at] : [],
    );
    if (byPart.length > 1) {
      return fallBack(`The choice "${choice.slice(0, 96)}" names more than one branch`);
    }
    index = byPart[0] ?? candidates.findIndex((candidate) => candidate.branch === choice);
  }
  if (index < 0) return fallBack(`The choice "${choice.slice(0, 96)}" names no candidate branch`);
  if (!usable(index)) {
    return fallBack(`The chosen branch "${choice.slice(0, 96)}" did not produce a commit`);
  }
  return { ok: true, index, matched: "choice" };
}

// ---------------------------------------------------------------- prompt

/**
 * The locked frame an isolated branch's prompt carries: where it works.
 * Sessions run in the environment's bridge, whose working directory is the
 * environment root, so the frame names the worktree; the guards check that
 * the run's checkout stayed untouched and the work was committed there.
 */
export function graphBranchWorktreeInstruction(input: {
  /** Absolute path of the worktree in the agent's filesystem. */
  directory: string;
  branch: string;
  baseRef: string;
  /** Absolute path of the run's own checkout. */
  root: string;
}): string {
  return [
    "## Your isolated worktree",
    "",
    `This step is one of several branches working in parallel. Your branch has its own Git worktree at \`${input.directory}\`, on branch \`${input.branch}\`, created from commit \`${input.baseRef}\`.`,
    "",
    `- Change directory to \`${input.directory}\` before every command, and create, edit and delete files only inside it.`,
    `- Commit all of your work on \`${input.branch}\` in that worktree before you submit; leave nothing uncommitted there. Do not switch it to another branch.`,
    `- Do not change the run's own checkout at \`${input.root}\` or any other branch's worktree, and never push. The run checks both after your turn and fails the step if they changed.`,
  ].join("\n");
}
