/**
 * Who pushed a commit the remote-ref guard found (item 209,
 * `graph-agent-guards.ts`). A ref on a watched remote that points at a
 * commit an activation created during its turn is a push by that
 * activation, unless another activation created the very same commit.
 *
 * Commits are content-addressed: two agents in sibling environments of one
 * project that make the same change on the same parent, with the same
 * identity, in the same second, make one commit id. The guard cannot tell
 * from the commit which of them pushed it, so it looks for the push itself
 * in each one's repository:
 *
 * - a branch: the remote-tracking ref (`refs/remotes/<remote>/<branch>`)
 *   has a reflog entry "update by push" to that commit within the
 *   activation's window. Only the repository that ran `git push <remote>`
 *   records one (a fetch says "fetch").
 * - a tag: the repository has the tag, pointing at that commit.
 *
 * The other activations considered (peers) are those whose windows overlap
 * this one's, in any run (`graphGuardPeerSource`). A peer that cannot be
 * read is not considered, so it can never clear an activation.
 *
 * The decision for a ref that points at a commit this activation created:
 * - no peer created it: this activation pushed it (violated, as before);
 * - this repository recorded no push and a peer's did: the peer pushed it;
 *   this activation passes;
 * - this repository recorded the push and no claiming peer's did: violated;
 * - otherwise ambiguous, and the guard fails closed (`unavailable`) naming
 *   why. That is the case for two local environments of one project: they
 *   are worktrees of one repository, which shares remote-tracking refs, tags
 *   and their reflogs, so Git holds nothing that says which worktree ran the
 *   push. A push by URL, or with reflogs off, leaves no evidence anywhere.
 */
import {
  GRAPH_ACTIVATION_TERMINAL_STATES,
  GRAPH_COMMIT_PATTERN,
  type GraphActivationBaseline,
  type GraphActivationWorktree,
  type GraphRun,
} from "@orkestrator/protocol/graphs/run";
import type { EnvironmentGit } from "./build-pipeline-code-rewind.js";

/** Clock skew tolerated between the backend and the environment, seconds. */
export const GRAPH_GUARD_CLOCK_SKEW_SECONDS = 2;
/** Commits of an activation the guard looks for on the remote. */
const MAX_CREATED_COMMITS = 1_000;
const MAX_REFLOG_ENTRIES = 200;
/** Reflog entries of one remote-tracking ref read for evidence. */
const MAX_TRACKING_REFLOG_ENTRIES = 50;
/** Peers considered per certification (newest first). */
export const MAX_GRAPH_GUARD_PEERS = 16;

/** Another activation whose turn overlapped the one being certified. */
export interface GraphGuardPeer {
  /** Content-free, for the guard's detail: "step <id> of run <id>". */
  label: string;
  environmentId: string;
  baseline: GraphActivationBaseline & { capturedAt: string };
  worktree?: GraphActivationWorktree;
  /** When it finished; absent while it runs. */
  finishedAt?: string;
}

/** The activation being certified, for {@link GraphGuardPeerSource}. */
export interface GraphGuardPeerQuery {
  runId: string;
  activationKey?: string;
  /** Its capture time (ISO); peers that finished before it are not considered. */
  since: string;
}

export type GraphGuardPeerSource = (query: GraphGuardPeerQuery) => Promise<GraphGuardPeer[]>;

/** What an activation's repository records about a ref's push. */
export type GraphPushEvidence = "pushed" | "none" | "unknown";

/** A window in Unix seconds, inclusive, skew already applied. */
export interface GraphGuardWindow {
  since: number;
  until?: number;
}

export function graphGuardWindow(capturedAt: string, finishedAt?: string): GraphGuardWindow {
  return {
    since: Math.floor(Date.parse(capturedAt) / 1000) - GRAPH_GUARD_CLOCK_SKEW_SECONDS,
    ...(finishedAt
      ? { until: Math.ceil(Date.parse(finishedAt) / 1000) + GRAPH_GUARD_CLOCK_SKEW_SECONDS }
      : {}),
  };
}

function within(time: number, window: GraphGuardWindow): boolean {
  return (
    Number.isFinite(time) &&
    time >= window.since &&
    (window.until === undefined || time <= window.until)
  );
}

/**
 * Commits an activation created during its turn: `base..HEAD` and the
 * worktree's HEAD reflog within the window, each with a commit time inside
 * it (a fast-forward onto older commits brings none in). An isolated branch
 * (item 403) is read in its own worktree, from its own base.
 */
export async function graphCreatedCommits(
  environmentGit: EnvironmentGit,
  environmentId: string,
  baseline: GraphActivationBaseline,
  window: GraphGuardWindow,
  worktree?: GraphActivationWorktree,
): Promise<Set<string>> {
  const git = worktree
    ? (args: string[]) => environmentGit(environmentId, ["-C", worktree.path, ...args])
    : (args: string[]) => environmentGit(environmentId, args);
  const base = worktree?.baseRef ?? baseline.headRef;
  const created = new Set<string>();
  const range = await git([
    "log",
    "--format=%H %ct",
    `--max-count=${MAX_CREATED_COMMITS}`,
    `${base}..HEAD`,
  ]);
  for (const line of range.split("\n")) {
    const [sha, time] = line.trim().split(" ");
    if (sha && GRAPH_COMMIT_PATTERN.test(sha) && within(Number(time), window)) created.add(sha);
  }
  // The reflog is per worktree; a repository without one simply has none.
  const reflog = await git([
    "log",
    "-g",
    "--date=unix",
    "--format=%H %ct %gd",
    `--max-count=${MAX_REFLOG_ENTRIES}`,
    "HEAD",
  ]).catch(() => "");
  for (const line of reflog.split("\n")) {
    const [sha, time, selector] = line.trim().split(" ");
    const moved = Number(/@\{(\d+)\}$/.exec(selector ?? "")?.[1]);
    if (
      sha &&
      GRAPH_COMMIT_PATTERN.test(sha) &&
      within(Number(time), window) &&
      within(moved, window)
    ) {
      created.add(sha);
    }
  }
  return created;
}

/** The exact ref's value in the repository (`for-each-ref` also matches below a prefix). */
async function localRef(
  git: (args: string[]) => Promise<string>,
  ref: string,
): Promise<{ sha: string; peeled?: string } | null> {
  const output = await git([
    "for-each-ref",
    "--format=%(refname) %(objectname) %(*objectname)",
    ref,
  ]);
  for (const line of output.split("\n")) {
    const [name, sha, peeled] = line.trim().split(" ");
    if (name === ref && sha)
      return { sha: sha.toLowerCase(), ...(peeled ? { peeled: peeled.toLowerCase() } : {}) };
  }
  return null;
}

/**
 * Whether an environment's repository records pushing `sha` to `ref` on
 * `remote` within the window. Read failures answer `unknown`, never `none`.
 */
export async function graphPushEvidence(
  environmentGit: EnvironmentGit,
  environmentId: string,
  push: { remote: string; ref: string; sha: string },
  window: GraphGuardWindow,
): Promise<GraphPushEvidence> {
  const git = (args: string[]) => environmentGit(environmentId, args);
  try {
    if (push.ref.startsWith("refs/tags/")) {
      const tag = await localRef(git, push.ref);
      return tag && (tag.sha === push.sha || tag.peeled === push.sha) ? "pushed" : "none";
    }
    if (!push.ref.startsWith("refs/heads/")) return "unknown";
    const tracking = `refs/remotes/${push.remote}/${push.ref.slice("refs/heads/".length)}`;
    const current = await localRef(git, tracking);
    if (!current) return "none";
    const reflog = await git([
      "log",
      "-g",
      "--date=unix",
      "--format=%H %gd %gs",
      `--max-count=${MAX_TRACKING_REFLOG_ENTRIES}`,
      tracking,
      "--",
    ]);
    const entries = reflog
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    for (const entry of entries) {
      const [sha, selector, ...subject] = entry.split(" ");
      const at = Number(/@\{(\d+)\}$/.exec(selector ?? "")?.[1]);
      if (
        sha?.toLowerCase() === push.sha &&
        subject.join(" ").startsWith("update by push") &&
        within(at, window)
      ) {
        return "pushed";
      }
    }
    // A tracking ref at the commit with no reflog to say how it got there.
    return entries.length === 0 && current.sha === push.sha ? "unknown" : "none";
  } catch {
    return "unknown";
  }
}

/** Who a ref pointing at a commit this activation created is blamed on. */
export type GraphPushAttribution =
  { kind: "self" } | { kind: "peer"; peer: string } | { kind: "ambiguous"; reason: string };

/**
 * The decision described at the top of this module, from this activation's
 * evidence and that of every peer that created the same commit.
 */
export function graphAttributePush(
  self: GraphPushEvidence,
  claimants: ReadonlyArray<{ label: string; evidence: GraphPushEvidence; sameCheckout?: boolean }>,
): GraphPushAttribution {
  if (claimants.length === 0) return { kind: "self" };
  const sharing = claimants.filter((claimant) => claimant.sameCheckout);
  if (sharing.length > 0) {
    // One checkout's HEAD reflog and refs are every step's in it.
    return {
      kind: "ambiguous",
      reason: `${sharing.map((claimant) => claimant.label).join(", ")} ran in the same checkout during this step's turn, and Git does not record which step committed or pushed there`,
    };
  }
  const pushers = claimants.filter((claimant) => claimant.evidence === "pushed");
  if (self === "none" && pushers.length > 0) return { kind: "peer", peer: pushers[0]!.label };
  if (self === "pushed" && claimants.every((claimant) => claimant.evidence === "none")) {
    return { kind: "self" };
  }
  const names = claimants.map((claimant) => claimant.label).join(", ");
  if (self === "pushed" && pushers.length > 0) {
    return {
      kind: "ambiguous",
      reason: `${names} made the identical commit, and Git recorded the push in a repository both share (local environments of one project are worktrees of one repository), so it cannot tell which step pushed`,
    };
  }
  if (self === "unknown" || claimants.some((claimant) => claimant.evidence === "unknown")) {
    return {
      kind: "ambiguous",
      reason: `${names} made the identical commit, and the push evidence in the repositories could not be read`,
    };
  }
  return {
    kind: "ambiguous",
    reason: `${names} made the identical commit, and no repository recorded the push (a push by URL, or one without reflogs)`,
  };
}

/**
 * Peers from the stored runs: every other agent activation that recorded a
 * baseline and had not finished before `since`, newest first, bounded. Mock
 * runs have no workspace and are skipped.
 */
export function graphGuardPeerSource(dependencies: {
  listRuns(): Promise<readonly GraphRun[]>;
  now?: () => Date;
}): GraphGuardPeerSource {
  const terminal: ReadonlySet<string> = new Set(GRAPH_ACTIVATION_TERMINAL_STATES);
  return async (query) => {
    const since = Date.parse(query.since) - GRAPH_GUARD_CLOCK_SKEW_SECONDS * 1000;
    const now = (dependencies.now?.() ?? new Date()).getTime();
    const peers: GraphGuardPeer[] = [];
    for (const run of await dependencies.listRuns()) {
      if (run.mock || !run.environmentId) continue;
      for (const activation of run.activations) {
        const capturedAt = activation.baseline?.capturedAt;
        if (!capturedAt || !activation.baseline) continue;
        if (run.id === query.runId && activation.key === query.activationKey) continue;
        const captured = Date.parse(capturedAt);
        if (!Number.isFinite(captured) || captured > now) continue;
        // A finished activation without a finish time is too old to tell.
        if (!activation.finishedAt && terminal.has(activation.state)) continue;
        if (activation.finishedAt && Date.parse(activation.finishedAt) < since) continue;
        peers.push({
          label: `step ${activation.nodeId} of run ${run.id}`,
          environmentId: run.environmentId,
          baseline: { ...activation.baseline, capturedAt },
          ...(activation.worktree ? { worktree: activation.worktree } : {}),
          ...(activation.finishedAt ? { finishedAt: activation.finishedAt } : {}),
        });
      }
    }
    return peers
      .sort((left, right) => right.baseline.capturedAt.localeCompare(left.baseline.capturedAt))
      .slice(0, MAX_GRAPH_GUARD_PEERS);
  };
}
