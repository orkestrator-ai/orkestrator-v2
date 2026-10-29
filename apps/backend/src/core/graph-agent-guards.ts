/**
 * The post-hoc guards around every graph agent activation (item 209, plan
 * P2.9; report §6.4 point 3, §6.6; D12). Guards detect; they do not prevent.
 * Each one fails closed: a state the backend cannot observe stops the
 * activation instead of letting it through unchecked.
 *
 * - **Read-only** (nodes with `workspaceAccess: read` or `none`): the
 *   generic guard from item 001 (`workspace-read-only-guard.ts`). The
 *   baseline (HEAD and the Git-visible uncommitted paths) is captured before
 *   dispatch, and a node whose baseline cannot be established fails there.
 *   At submit time an acceptance check on the activation's own result keys
 *   hands the agent a correctable `worktree_changed` refusal, so it can put
 *   the tree back within its turn. When the result is consumed (before any
 *   artifact is stored) the worktree is certified again; a change fails the
 *   activation and the worktree is left as the evidence.
 * - **Remote refs** (every agent node; none may push, D12): the run branch on
 *   each watched remote (`origin`, the branch's upstream remote, or every
 *   remote when neither exists) is read with `git ls-remote` before dispatch.
 *   After the turn the watched remotes' heads and tags are listed again. A
 *   push is detected when the run branch moved, or when any ref now points
 *   at a commit the activation created (committed during its turn: in
 *   `baseline..HEAD` or the worktree's HEAD reflog since the capture, with a
 *   commit time after it). Commits a run's own `push-branch` or
 *   `open-pull-request` node pushed are never counted against an agent. When
 *   another activation whose turn overlapped created the identical commit,
 *   the push is attributed through each repository's own record of it
 *   (`graph-agent-remote-attribution.ts`); where Git cannot tell, the guard
 *   fails closed and says why.
 *
 * - **Worktree** (isolated branches, item 403): the branch writes its own
 *   worktree, so the run's checkout gets the read-only guard above, and the
 *   branch's worktree is certified: it still exists, is on its own branch,
 *   descends from its base commit and holds no uncommitted change (a
 *   correctable refusal at submit time first). The remote-ref guard reads
 *   the commits the branch created in its own worktree.
 *
 * What the remote-ref guard cannot see: a push to a URL or a remote that is
 * not watched, a push of commits that existed before the turn to another
 * branch, a commit whose date was forged, and GitHub writes that are not
 * pushes. Withholding the GitHub credential from the session environment
 * (`withheldGitHubCredentialEnvironment`, per bridge) is the other half.
 *
 * Results go to the activation's `guards` slot (item 201): content-free
 * details and bounded evidence (paths, refs), never file contents.
 */
import { createHash } from "node:crypto";
import { AGENT_PLATFORM_LABELS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { GraphPlanAgentNode } from "@orkestrator/protocol/graphs/compile";
import type { GraphEnforcementTier } from "@orkestrator/protocol/graphs/template";
import {
  GRAPH_COMMIT_PATTERN,
  GRAPH_RUN_BOUNDS,
  type GraphActivationBaseline,
  type GraphActivationWorktree,
  type GraphGuardKind,
  type GraphGuardOutcome,
  type GraphGuardResult,
  type GraphUpstreamRef,
} from "@orkestrator/protocol/graphs/run";
import type { WorkflowResultError } from "@orkestrator/protocol/workflow-results";
import type { EnvironmentGit } from "./build-pipeline-code-rewind.js";
import type { ObservedWorktreeSnapshot, ReviewWorktreeSnapshot } from "./build-pipeline-prompts.js";
import {
  graphAttributePush,
  graphCreatedCommits,
  graphGuardWindow,
  graphPushEvidence,
  MAX_GRAPH_GUARD_PEERS,
  type GraphGuardPeer,
  type GraphGuardPeerSource,
  type GraphPushEvidence,
} from "./graph-agent-remote-attribution.js";
import { graphCommandErrorLine } from "./graph-system-environment.js";
import type { Environment } from "./models.js";
import {
  WorkspaceBaselineUnavailableError,
  WorkspaceReadOnlyGuard,
  compareWorkspace,
  readOnlyViolationMessage,
  readOnlyViolationRefusal,
  type ReadOnlyGuardSubject,
  type WorkspaceChange,
  type WorkspaceSnapshotProbe,
} from "./workspace-read-only-guard.js";
import type {
  WorkflowResultAcceptanceCheck,
  WorkflowResultAttempt,
} from "./workflow-result-service.js";

/** `git ls-remote <args>` in the environment, with its credentials (never prompting). */
export type GraphLsRemote = (environment: Environment, args: string[]) => Promise<string>;

export interface GraphAgentGuardDependencies {
  /** The backend's worktree probe (`get_environment_uncommitted_paths`). */
  probe: WorkspaceSnapshotProbe;
  /** Local Git in the environment: remotes, commit times, the HEAD reflog. */
  git?: EnvironmentGit;
  lsRemote?: GraphLsRemote;
  /** Commits the run's system nodes pushed or are pushing (effects `push:<branch>:<sha>`). */
  systemPushes?(runId: string): Promise<ReadonlySet<string>>;
  /**
   * Other activations whose turns overlapped (`graphGuardPeerSource`), for
   * attributing an identical commit. Without it, or when it fails, every
   * commit the activation created is its own.
   */
  peers?: GraphGuardPeerSource;
  now?: () => Date;
}

/** A guard stopped the activation, before dispatch or when its result was consumed. */
export class GraphAgentGuardError extends Error {
  constructor(
    message: string,
    readonly results: GraphGuardResult[],
  ) {
    super(message);
    this.name = "GraphAgentGuardError";
  }
}

/** What a guarded submission belongs to, for the acceptance check. */
export interface GraphGuardedAttempt {
  environmentId: string;
  node: GuardNode;
  baseline: GraphActivationBaseline | undefined;
  /** An isolated branch's own worktree (item 403). */
  worktree?: GraphActivationWorktree;
}

type GuardNode = Pick<GraphPlanAgentNode, "id" | "label" | "workspaceAccess" | "isolation">;

/** Remotes watched per activation (the protocol bound). */
const MAX_REMOTES = GRAPH_RUN_BOUNDS.maxBaselineUpstreamRefs;
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const SAFE_BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;
const LS_REMOTE_ATTEMPTS = 3;
/** Refs a listing may hold before the guard refuses to judge it. */
const MAX_LISTED_REFS = 100_000;
/** Pushed refs attributed one by one; any beyond are blamed on the activation. */
const MAX_ATTRIBUTED_REFS = 20;
const MAX_REFUSAL_PATHS = 50;

export function graphGuardSubject(node: GuardNode): ReadOnlyGuardSubject {
  return { stage: `Step ${node.label ?? node.id}`, activity: "the step" };
}

/**
 * Whether the read-only guard applies to a node's view of the run's
 * checkout: readers, and isolated branches, which write only their own
 * worktree (item 403).
 */
export function graphNodeIsReadOnlyGuarded(
  node: Pick<GuardNode, "workspaceAccess" | "isolation">,
): boolean {
  return node.workspaceAccess !== "write" || node.isolation === "worktree";
}

/** SHA-256 over a path set: sorted, each path followed by NUL. */
export function graphPathsDigest(paths: readonly string[]): string {
  const hash = createHash("sha256");
  for (const path of [...paths].sort()) hash.update(`${path}\0`);
  return hash.digest("hex");
}

function bounded(text: string, max: number = GRAPH_RUN_BOUNDS.maxGuardDetailChars): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function guardResult(
  guard: GraphGuardKind,
  outcome: GraphGuardOutcome,
  at: string,
  detail: string,
  paths?: readonly string[],
): GraphGuardResult {
  const evidence = (paths ?? [])
    .filter(
      (path) => path.length > 0 && path.length <= 1_024 && !/[\u0000-\u001f\u007f]/.test(path),
    )
    .slice(0, GRAPH_RUN_BOUNDS.maxGuardPaths);
  return {
    guard,
    outcome,
    at,
    detail: bounded(detail),
    ...(evidence.length > 0 ? { paths: evidence } : {}),
  };
}

/** Replaces each guard's earlier result with its newest one (at most 8 kept). */
export function mergeGraphGuardResults(
  existing: readonly GraphGuardResult[] | undefined,
  next: readonly GraphGuardResult[],
): GraphGuardResult[] {
  const replaced = new Set(next.map((result) => result.guard));
  return [...(existing ?? []).filter((result) => !replaced.has(result.guard)), ...next].slice(
    -GRAPH_RUN_BOUNDS.maxGuardResults,
  );
}

function short(sha: string | null): string {
  return sha ? sha.slice(0, 12) : "(absent)";
}

function snapshotPaths(snapshot: ObservedWorktreeSnapshot): string[] {
  return snapshot.status === "dirty" ? [...snapshot.paths].sort() : [];
}

/** Lists refs as `ref → sha`, peeled tags (`^{}`) under their tag's name too. */
function parseListing(output: string): Map<string, Set<string>> {
  const refs = new Map<string, Set<string>>();
  let count = 0;
  for (const line of output.split("\n")) {
    const [sha, name] = line.trim().split(/\s+/, 2);
    if (!sha || !name || !GRAPH_COMMIT_PATTERN.test(sha.toLowerCase())) continue;
    if (++count > MAX_LISTED_REFS) throw new Error("the remote lists too many refs to check");
    const ref = name.endsWith("^{}") ? name.slice(0, -3) : name;
    const values = refs.get(ref) ?? new Set<string>();
    values.add(sha.toLowerCase());
    refs.set(ref, values);
  }
  return refs;
}

/** The run branch's value: the ref's own (unpeeled) entry. */
function branchValue(output: string, ref: string): string | null {
  for (const line of output.split("\n")) {
    const [sha, name] = line.trim().split(/\s+/, 2);
    if (name === ref && sha && GRAPH_COMMIT_PATTERN.test(sha.toLowerCase()))
      return sha.toLowerCase();
  }
  return null;
}

/** The tool error for a path set that changed when only its digest was kept. */
function digestRefusal(
  subject: ReadOnlyGuardSubject,
  before: number | undefined,
  current: readonly string[],
): WorkflowResultError {
  const shown = current.slice(0, MAX_REFUSAL_PATHS);
  const listed = shown.map((path) => `- \`${path.replaceAll("`", "'")}\``).join("\n");
  const omitted = current.length - shown.length;
  return {
    code: "worktree_changed",
    nextAction: "correct",
    message: `${subject.activity.charAt(0).toUpperCase()}${subject.activity.slice(1)} changed the set of uncommitted paths in this checkout (${before ?? "an unknown number"} when it started, ${current.length} now), so the result cannot be accepted. The paths uncommitted now are:\n${listed}${omitted > 0 ? `\n- …and ${omitted} more.` : ""}\nRemove what the step created and restore what it removed, until the set is the one it started with. Then submit your result again. Do not commit, stash, reset or delete the uncommitted work that was already there.`,
  };
}

export class GraphAgentGuards {
  private readonly readOnly: WorkspaceReadOnlyGuard;
  private readonly now: () => Date;

  constructor(private readonly dependencies: GraphAgentGuardDependencies) {
    this.readOnly = new WorkspaceReadOnlyGuard(dependencies.probe);
    this.now = dependencies.now ?? (() => new Date());
  }

  // ------------------------------------------------------------ before dispatch

  /**
   * The baseline to record before the session exists. Throws
   * {@link GraphAgentGuardError} when the workspace or the upstream refs
   * cannot be observed: the activation fails without a session.
   */
  async capture(environment: Environment, node: GuardNode): Promise<GraphActivationBaseline> {
    const subject = graphGuardSubject(node);
    const at = this.now().toISOString();
    const readOnly = graphNodeIsReadOnlyGuarded(node);
    let snapshot: ObservedWorktreeSnapshot;
    try {
      if (readOnly) {
        snapshot = (await this.readOnly.capture(environment.id, subject)).snapshot;
      } else {
        const observed = await this.dependencies.probe(environment.id);
        if (observed.status === "unknown") {
          throw new WorkspaceBaselineUnavailableError(subject, observed.reason);
        }
        snapshot = observed;
      }
    } catch (error) {
      if (!(error instanceof WorkspaceBaselineUnavailableError)) throw error;
      throw new GraphAgentGuardError(error.message, [
        guardResult(readOnly ? "read-only" : "remote-ref", "unavailable", at, error.message),
      ]);
    }
    const headRef = snapshot.head.toLowerCase();
    if (!GRAPH_COMMIT_PATTERN.test(headRef)) {
      const message = `${subject.stage} cannot start because the environment HEAD is not a commit the run can record`;
      throw new GraphAgentGuardError(message, [
        guardResult(readOnly ? "read-only" : "remote-ref", "unavailable", at, message),
      ]);
    }
    const paths = snapshotPaths(snapshot);
    const keepPaths =
      readOnly &&
      paths.length <= GRAPH_RUN_BOUNDS.maxBaselinePaths &&
      paths.every(
        (path) =>
          path.length > 0 &&
          path.length <= GRAPH_RUN_BOUNDS.maxBaselinePathChars &&
          !/[\u0000-\u001f\u007f]/.test(path),
      );
    const upstream = await this.captureUpstream(environment, subject, at);
    return {
      headRef,
      pathsDigest: graphPathsDigest(paths),
      pathCount: paths.length,
      ...(keepPaths ? { paths } : {}),
      capturedAt: at,
      upstream,
    };
  }

  private async captureUpstream(
    environment: Environment,
    subject: ReadOnlyGuardSubject,
    at: string,
  ): Promise<GraphUpstreamRef[]> {
    const unavailable = (reason: string): never => {
      const message = `${subject.stage} cannot start because the backend could not read the upstream refs it must compare after the step: ${reason}`;
      throw new GraphAgentGuardError(message, [
        guardResult("remote-ref", "unavailable", at, message),
      ]);
    };
    const remotes = await this.watchedRemotes(environment).catch((error: unknown) =>
      unavailable(graphCommandErrorLine(error)),
    );
    if (remotes.length === 0) return [];
    const ref = branchRef(environment);
    if (!ref) return unavailable("the environment has no branch to watch");
    const upstream: GraphUpstreamRef[] = [];
    for (const remote of remotes) {
      const output = await this.listRemote(environment, [remote, ref]).catch((error: unknown) =>
        unavailable(`${remote}: ${graphCommandErrorLine(error)}`),
      );
      upstream.push({ remote, ref, sha: branchValue(output, ref) });
    }
    return upstream;
  }

  /** `origin` and the branch's upstream remote; every remote (bounded) when neither exists. */
  private async watchedRemotes(environment: Environment): Promise<string[]> {
    const git = this.dependencies.git;
    if (!git) throw new Error("the environment's Git is unavailable");
    const configured = (await git(environment.id, ["remote"]))
      .split("\n")
      .map((line) => line.trim())
      .filter((name) => REMOTE_NAME.test(name));
    if (configured.length === 0) return [];
    const watched = new Set<string>();
    if (configured.includes("origin")) watched.add("origin");
    const ref = branchRef(environment);
    if (ref) {
      const upstreamRemote = (
        await git(environment.id, [
          "config",
          "--get",
          `branch.${ref.slice("refs/heads/".length)}.remote`,
        ]).catch(() => "")
      ).trim();
      if (configured.includes(upstreamRemote)) watched.add(upstreamRemote);
    }
    if (watched.size === 0) for (const name of configured) watched.add(name);
    return [...watched].slice(0, MAX_REMOTES);
  }

  private async listRemote(environment: Environment, args: string[]): Promise<string> {
    const lsRemote = this.dependencies.lsRemote;
    if (!lsRemote) throw new Error("the backend cannot reach this environment's remotes");
    let last: unknown;
    for (let attempt = 0; attempt < LS_REMOTE_ATTEMPTS; attempt++) {
      try {
        return await lsRemote(environment, args);
      } catch (error) {
        last = error;
      }
    }
    throw last;
  }

  // ------------------------------------------------------------ at submit time

  /**
   * The correctable refusal for a read-only activation's submission, or null
   * to accept. States the backend cannot judge are left to consumption.
   */
  async refusal(attempt: GraphGuardedAttempt): Promise<WorkflowResultError | null> {
    const { node, baseline } = attempt;
    if (!graphNodeIsReadOnlyGuarded(node) || !baseline?.capturedAt) return null;
    const subject = graphGuardSubject(node);
    const snapshot = await this.dependencies.probe(attempt.environmentId);
    if (snapshot.status === "unknown") return null;
    const change = this.workspaceChange(baseline, snapshot);
    if (change.kind === "digest") return digestRefusal(subject, baseline.pathCount, change.paths);
    const refusal = readOnlyViolationRefusal(subject, change);
    if (refusal || !attempt.worktree) return refusal;
    return this.worktreeRefusal(attempt.environmentId, attempt.worktree);
  }

  /** The correctable refusal for a branch whose worktree is off its branch or uncommitted. */
  private async worktreeRefusal(
    environmentId: string,
    worktree: GraphActivationWorktree,
  ): Promise<WorkflowResultError | null> {
    const state = await this.worktreeState(environmentId, worktree).catch(() => null);
    if (!state) return null;
    if (state.branch !== worktree.branch) {
      return {
        code: "worktree_changed",
        nextAction: "correct",
        message: `Your worktree \`${worktree.path}\` is no longer on its branch \`${worktree.branch}\`. Switch it back (\`git -C ${worktree.path} switch ${worktree.branch}\`), keep your commits on that branch, then submit again.`,
      };
    }
    if (state.dirty.length === 0) return null;
    const shown = state.dirty.slice(0, MAX_REFUSAL_PATHS);
    const listed = shown.map((path) => `- \`${path.replaceAll("`", "'")}\``).join("\n");
    return {
      code: "worktree_changed",
      nextAction: "correct",
      message: `Your worktree \`${worktree.path}\` has uncommitted changes, so the result cannot be accepted:\n${listed}${state.dirty.length > shown.length ? `\n- …and ${state.dirty.length - shown.length} more.` : ""}\nCommit the work you mean to keep on \`${worktree.branch}\` and remove the rest, then submit again.`,
    };
  }

  /** HEAD, branch and uncommitted paths of a branch worktree (`git -C <path>`). */
  private async worktreeState(
    environmentId: string,
    worktree: GraphActivationWorktree,
  ): Promise<{ head: string; branch: string; dirty: string[]; descends: boolean }> {
    const git = this.dependencies.git;
    if (!git) throw new Error("the environment's Git is unavailable");
    const inWorktree = (args: string[]) => git(environmentId, ["-C", worktree.path, ...args]);
    const head = (await inWorktree(["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    if (!GRAPH_COMMIT_PATTERN.test(head)) throw new Error("the worktree HEAD is not a commit");
    const branch = (
      await inWorktree(["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")
    ).trim();
    const dirty = (await inWorktree(["status", "--porcelain", "--untracked-files=all"]))
      .split("\n")
      .map((line) => line.slice(3).trim())
      .filter((path) => path.length > 0);
    const descends = await inWorktree(["merge-base", "--is-ancestor", worktree.baseRef, head])
      .then(() => true)
      .catch(() => false);
    return { head, branch, dirty, descends };
  }

  /** An acceptance check for `graph-output` slots; `resolve` names the guarded activation. */
  acceptanceCheck(
    resolve: (attempt: WorkflowResultAttempt) => Promise<GraphGuardedAttempt | null>,
  ): WorkflowResultAcceptanceCheck {
    return async (attempt) => {
      const owned = await resolve(attempt);
      return owned ? this.refusal(owned) : null;
    };
  }

  // ------------------------------------------------------------ when consumed

  /**
   * Certifies a finished turn before its result becomes artifacts: the
   * read-only guard (read and none nodes, isolated branches), the worktree
   * guard (isolated branches) and the remote-ref guard (every node). Returns the results; throws {@link GraphAgentGuardError} with
   * them when any guard was violated or could not judge.
   */
  async certify(input: {
    environment: Environment;
    node: GuardNode;
    baseline: GraphActivationBaseline | undefined;
    runId: string;
    /** The activation itself, so it is not its own peer. */
    activationKey?: string;
    /** An isolated branch's own worktree (item 403). */
    worktree?: GraphActivationWorktree;
  }): Promise<GraphGuardResult[]> {
    const results: GraphGuardResult[] = [];
    let failure: string | undefined;
    const record = (outcome: { result: GraphGuardResult; failure?: string }) => {
      results.push(outcome.result);
      failure ??= outcome.failure;
    };
    if (graphNodeIsReadOnlyGuarded(input.node)) record(await this.certifyReadOnly(input));
    if (input.node.isolation === "worktree") record(await this.certifyWorktree(input));
    record(await this.certifyRemote(input));
    if (failure) throw new GraphAgentGuardError(failure, results);
    return results;
  }

  private workspaceChange(
    baseline: GraphActivationBaseline,
    snapshot: ObservedWorktreeSnapshot,
  ): WorkspaceChange | { kind: "digest"; paths: string[] } {
    if (baseline.paths) {
      return compareWorkspace({ head: baseline.headRef, paths: baseline.paths }, snapshot);
    }
    if (snapshot.head.toLowerCase() !== baseline.headRef) {
      return { kind: "head", before: baseline.headRef, after: snapshot.head };
    }
    const current = snapshotPaths(snapshot);
    return graphPathsDigest(current) === baseline.pathsDigest
      ? { kind: "unchanged" }
      : { kind: "digest", paths: current };
  }

  private async certifyReadOnly(input: {
    environment: Environment;
    node: GuardNode;
    baseline: GraphActivationBaseline | undefined;
  }): Promise<{ result: GraphGuardResult; failure?: string }> {
    const at = this.now().toISOString();
    const subject = graphGuardSubject(input.node);
    const baseline = input.baseline;
    if (!baseline?.capturedAt) {
      return {
        result: guardResult(
          "read-only",
          "unavailable",
          at,
          "This activation started before the read-only guard recorded baselines, so it was not certified.",
        ),
      };
    }
    let snapshot: ReviewWorktreeSnapshot;
    try {
      snapshot = await this.dependencies.probe(input.environment.id);
    } catch (error) {
      snapshot = { status: "unknown", reason: graphCommandErrorLine(error) };
    }
    if (snapshot.status === "unknown") {
      const message = readOnlyViolationMessage(subject, {
        kind: "unknown",
        reason: snapshot.reason,
      })!;
      return { result: guardResult("read-only", "unavailable", at, message), failure: message };
    }
    const change = this.workspaceChange(baseline, snapshot);
    if (change.kind === "unchanged") {
      return {
        result: guardResult(
          "read-only",
          "passed",
          at,
          "HEAD and the uncommitted paths match the start of the step.",
        ),
      };
    }
    if (change.kind === "digest") {
      const message = `${subject.stage} cannot be certified because ${subject.activity} changed the set of uncommitted paths (${baseline.pathCount ?? "an unknown number"} at the start, ${change.paths.length} now)`;
      return {
        result: guardResult("read-only", "violated", at, message, change.paths),
        failure: message,
      };
    }
    const message = readOnlyViolationMessage(subject, change)!;
    const evidence =
      change.kind === "added" || change.kind === "removed" ? change.paths : undefined;
    return {
      result: guardResult("read-only", "violated", at, message, evidence),
      failure: message,
    };
  }

  private async certifyWorktree(input: {
    environment: Environment;
    node: GuardNode;
    worktree?: GraphActivationWorktree;
  }): Promise<{ result: GraphGuardResult; failure?: string }> {
    const at = this.now().toISOString();
    const subject = graphGuardSubject(input.node);
    const worktree = input.worktree;
    if (!worktree) {
      const message = `${subject.stage} cannot be accepted because it recorded no worktree of its own`;
      return { result: guardResult("worktree", "unavailable", at, message), failure: message };
    }
    let state: Awaited<ReturnType<GraphAgentGuards["worktreeState"]>>;
    try {
      state = await this.worktreeState(input.environment.id, worktree);
    } catch (error) {
      const message = `${subject.stage} cannot be accepted because its worktree ${worktree.path} could not be read: ${graphCommandErrorLine(error)}`;
      return { result: guardResult("worktree", "unavailable", at, message), failure: message };
    }
    const violated = (message: string, paths?: readonly string[]) => ({
      result: guardResult("worktree", "violated", at, message, paths),
      failure: message,
    });
    if (state.branch !== worktree.branch) {
      return violated(
        `${subject.stage} cannot be accepted because its worktree is no longer on its branch ${worktree.branch}`,
      );
    }
    if (!state.descends) {
      return violated(
        `${subject.stage} cannot be accepted because its branch no longer descends from the commit it started from (${worktree.baseRef.slice(0, 12)})`,
      );
    }
    if (state.dirty.length > 0) {
      return violated(
        `${subject.stage} cannot be accepted because it left ${state.dirty.length} uncommitted path${state.dirty.length === 1 ? "" : "s"} in its worktree`,
        state.dirty,
      );
    }
    return {
      result: guardResult(
        "worktree",
        "passed",
        at,
        `The branch worktree is on ${worktree.branch}, descends from its base and is committed.`,
      ),
    };
  }

  private async certifyRemote(input: {
    environment: Environment;
    node: GuardNode;
    baseline: GraphActivationBaseline | undefined;
    runId: string;
    activationKey?: string;
    worktree?: GraphActivationWorktree;
  }): Promise<{ result: GraphGuardResult; failure?: string }> {
    const at = this.now().toISOString();
    const subject = graphGuardSubject(input.node);
    const baseline = input.baseline;
    if (!baseline?.capturedAt || baseline.upstream === undefined) {
      return {
        result: guardResult(
          "remote-ref",
          "unavailable",
          at,
          "This activation started before the remote-ref guard recorded upstream refs, so it was not checked.",
        ),
      };
    }
    if (baseline.upstream.length === 0) {
      return {
        result: guardResult("remote-ref", "passed", at, "The environment has no remote to watch."),
      };
    }
    const unavailable = (reason: string) => {
      const message = `${subject.stage} cannot be accepted because the backend could not verify the upstream refs after the step: ${reason}`;
      return { result: guardResult("remote-ref", "unavailable", at, message), failure: message };
    };
    const environmentGit = this.dependencies.git;
    if (!environmentGit) return unavailable("the environment's Git is unavailable");
    const window = graphGuardWindow(baseline.capturedAt);
    let created: Set<string>;
    let pushedBySystem: ReadonlySet<string>;
    try {
      created = await graphCreatedCommits(
        environmentGit,
        input.environment.id,
        baseline,
        window,
        input.worktree,
      );
      pushedBySystem = (await this.dependencies.systemPushes?.(input.runId)) ?? new Set();
    } catch (error) {
      return unavailable(graphCommandErrorLine(error));
    }
    const changes: string[] = [];
    const published: PublishedRef[] = [];
    for (const entry of baseline.upstream) {
      let output: string;
      let listing: Map<string, Set<string>>;
      try {
        output = await this.listRemote(input.environment, ["--heads", "--tags", entry.remote]);
        listing = parseListing(output);
      } catch (error) {
        return unavailable(`${entry.remote}: ${graphCommandErrorLine(error)}`);
      }
      const after = branchValue(output, entry.ref);
      const branchMoved = after !== entry.sha && !(after && pushedBySystem.has(after));
      if (branchMoved) {
        changes.push(`${entry.remote} ${entry.ref} moved ${short(entry.sha)} → ${short(after)}`);
      }
      for (const [ref, values] of listing) {
        // The run branch was judged above (a system node's push included).
        if (ref === entry.ref) continue;
        const sha = [...values].find((value) => created.has(value) && !pushedBySystem.has(value));
        if (sha) published.push({ remote: entry.remote, ref, sha });
      }
    }
    const attribution = await this.attribute(
      { ...input, baseline: { ...baseline, capturedAt: baseline.capturedAt } },
      environmentGit,
      published,
    );
    changes.push(...attribution.own);
    const remotes = [...new Set(baseline.upstream.map((entry) => entry.remote))];
    if (changes.length === 0 && attribution.ambiguous.length > 0) {
      const message = `${subject.stage} cannot be accepted because a push during its turn cannot be attributed (ambiguous): ${attribution.ambiguous.slice(0, 3).join("; ")}${attribution.ambiguous.length > 3 ? ` and ${attribution.ambiguous.length - 3} more` : ""}. The guard fails closed rather than guess.`;
      return {
        result: guardResult("remote-ref", "unavailable", at, message),
        failure: bounded(message, GRAPH_RUN_BOUNDS.maxErrorChars),
      };
    }
    if (changes.length === 0) {
      const others =
        attribution.others.length > 0
          ? ` ${attribution.others.slice(0, 3).join("; ")}${attribution.others.length > 3 ? ` and ${attribution.others.length - 3} more` : ""}.`
          : "";
      return {
        result: guardResult(
          "remote-ref",
          "passed",
          at,
          `No ref the step could have pushed changed on ${remotes.join(", ")}.${others}`,
        ),
      };
    }
    const message = `${subject.stage} cannot be accepted because it pushed during its turn, and agent steps never push (D12): ${changes.slice(0, 5).join("; ")}${changes.length > 5 ? ` and ${changes.length - 5} more` : ""}`;
    return {
      result: guardResult("remote-ref", "violated", at, message),
      failure: bounded(message, GRAPH_RUN_BOUNDS.maxErrorChars),
    };
  }

  /**
   * Splits the refs that point at commits this activation created into its
   * own pushes, pushes another activation's repository recorded (an
   * identical commit), and ones Git cannot attribute.
   */
  private async attribute(
    input: {
      environment: Environment;
      baseline: GraphActivationBaseline & { capturedAt: string };
      runId: string;
      activationKey?: string;
      worktree?: GraphActivationWorktree;
    },
    environmentGit: EnvironmentGit,
    published: readonly PublishedRef[],
  ): Promise<{ own: string[]; others: string[]; ambiguous: string[] }> {
    const own: string[] = [];
    const others: string[] = [];
    const ambiguous: string[] = [];
    if (published.length === 0) return { own, others, ambiguous };
    const describe = (push: PublishedRef) => `${push.remote} ${push.ref} → ${short(push.sha)}`;
    let peers: GraphGuardPeer[] = [];
    try {
      peers = (
        (await this.dependencies.peers?.({
          runId: input.runId,
          ...(input.activationKey ? { activationKey: input.activationKey } : {}),
          since: input.baseline.capturedAt,
        })) ?? []
      ).slice(0, MAX_GRAPH_GUARD_PEERS);
    } catch {
      // No peers: every commit it created is its own (fail closed).
    }
    const createdBy = new Map<GraphGuardPeer, Promise<Set<string> | null>>();
    const peerCreated = (peer: GraphGuardPeer) => {
      let created = createdBy.get(peer);
      if (!created) {
        // A peer that cannot be read can never clear this activation.
        created = graphCreatedCommits(
          environmentGit,
          peer.environmentId,
          peer.baseline,
          graphGuardWindow(peer.baseline.capturedAt, peer.finishedAt),
          peer.worktree,
        ).catch(() => null);
        createdBy.set(peer, created);
      }
      return created;
    };
    const window = graphGuardWindow(input.baseline.capturedAt);
    const checkout = input.worktree?.path ?? null;
    for (const [index, push] of published.entries()) {
      if (index >= MAX_ATTRIBUTED_REFS || peers.length === 0) {
        own.push(describe(push));
        continue;
      }
      const claimants: GraphGuardPeer[] = [];
      for (const peer of peers) {
        if ((await peerCreated(peer))?.has(push.sha)) claimants.push(peer);
      }
      if (claimants.length === 0) {
        own.push(describe(push));
        continue;
      }
      const evidence = (environmentId: string, peerWindow: typeof window) =>
        graphPushEvidence(environmentGit, environmentId, push, peerWindow);
      const self: GraphPushEvidence = await evidence(input.environment.id, window);
      const judged = [];
      for (const peer of claimants) {
        judged.push({
          label: peer.label,
          evidence: await evidence(
            peer.environmentId,
            graphGuardWindow(peer.baseline.capturedAt, peer.finishedAt),
          ),
          sameCheckout:
            peer.environmentId === input.environment.id &&
            (peer.worktree?.path ?? null) === checkout,
        });
      }
      const attribution = graphAttributePush(self, judged);
      if (attribution.kind === "self") own.push(describe(push));
      else if (attribution.kind === "peer") {
        others.push(`${describe(push)} is an identical commit that ${attribution.peer} pushed`);
      } else ambiguous.push(`${describe(push)}: ${attribution.reason}`);
    }
    return { own, others, ambiguous };
  }
}

/** A ref on a watched remote that points at a commit the activation created. */
interface PublishedRef {
  remote: string;
  ref: string;
  sha: string;
}

function branchRef(environment: Pick<Environment, "branch">): string | null {
  const branch = environment.branch?.trim();
  return branch && SAFE_BRANCH.test(branch) ? `refs/heads/${branch}` : null;
}

/**
 * The enforcement check at dispatch as a guard result: the tier the provider
 * holds the node's policy at on the live host, against its floor.
 */
export function graphEnforcementGuardResult(
  node: Pick<GraphPlanAgentNode, "minEnforcement">,
  platform: AgentPlatform,
  decision: { enforcement: GraphEnforcementTier; enforcementReason?: string },
  problem: string | null,
  now: Date,
): GraphGuardResult {
  const floor = node.minEnforcement ? ` (floor ${node.minEnforcement})` : "";
  const reason = decision.enforcementReason ? `: ${decision.enforcementReason}` : "";
  return guardResult(
    "enforcement",
    problem ? "violated" : "passed",
    now.toISOString(),
    problem ??
      `${AGENT_PLATFORM_LABELS[platform]} holds this step at ${decision.enforcement}${floor}${reason}`,
  );
}
