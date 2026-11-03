/**
 * The "checkout update" notice a coordinator conversation gets on its first
 * turn after the project's checkout moved.
 *
 * The coordinator reads the project's own checkout, and the backend keeps it
 * on its upstream: before a typed message, before mail wakes the main
 * coordinator, and after a PR merges. A conversation that read files in an
 * earlier turn would otherwise go on reasoning from what it read then. So the
 * first turn after a change says what came in: the commits and the changed
 * paths, bounded.
 *
 * "Since the conversation's previous turn" is the repository context revision
 * its newest dispatched turn carried (`repositoryContextRevisionAcknowledged`,
 * advanced only once a turn is dispatched), compared with the workspace's
 * revision and its bounded event log (`repositoryContextEvents`). A
 * conversation's first turn gets no notice: it has read nothing yet.
 */
import type {
  CoordinatorConversation,
  CoordinatorRepositoryContextSource,
  CoordinatorWorkspace,
} from "@orkestrator/protocol/coordinator";
import type { CheckoutChanges } from "./project-git-service.js";

export interface PendingCheckoutUpdate {
  /** Null when the starting commit is no longer known (an evicted or older event). */
  fromCommit: string | null;
  fromBranch: string | null;
  toCommit: string | null;
  toBranch: string | null;
  /** What moved HEAD in between; `unknown` for events from older releases. */
  sources: ReadonlySet<CoordinatorRepositoryContextSource | "unknown">;
}

/** The change since `conversation`'s previous turn, or null when there is none to tell. */
export function pendingCheckoutUpdate(
  workspace: Pick<
    CoordinatorWorkspace,
    "repositoryContextRevision" | "repositoryContextEvents" | "repositoryStatus"
  >,
  conversation: Pick<CoordinatorConversation, "repositoryContextRevisionAcknowledged">,
): PendingCheckoutUpdate | null {
  const acknowledged = conversation.repositoryContextRevisionAcknowledged;
  if (acknowledged === undefined || acknowledged >= workspace.repositoryContextRevision) {
    return null;
  }
  const events = (workspace.repositoryContextEvents ?? [])
    .filter(
      (event) =>
        event.revision > acknowledged && event.revision <= workspace.repositoryContextRevision,
    )
    .sort((a, b) => a.revision - b.revision);
  const first = events[0];
  const last = events.at(-1);
  if (!first || !last) {
    // Every event since then was evicted; say what the checkout is now.
    return {
      fromCommit: null,
      fromBranch: null,
      toCommit: workspace.repositoryStatus?.headCommit ?? null,
      toBranch: workspace.repositoryStatus?.branch ?? null,
      sources: new Set(["unknown"]),
    };
  }
  const contiguous = first.revision === acknowledged + 1;
  const fromCommit = contiguous ? (first.previousHeadCommit ?? null) : null;
  const fromBranch = contiguous ? (first.previousBranch ?? null) : null;
  // Moved and came back: nothing the conversation read has changed.
  if (fromCommit && fromCommit === last.headCommit && fromBranch === last.branch) return null;
  const sources = new Set<CoordinatorRepositoryContextSource | "unknown">(
    events.map((event) => event.source ?? "unknown"),
  );
  if (!contiguous) sources.add("unknown");
  return {
    fromCommit,
    fromBranch,
    toCommit: last.headCommit,
    toBranch: last.branch,
    sources,
  };
}

const short = (commit: string | null) => (commit ? commit.slice(0, 12) : "an unknown commit");

/**
 * Commit subjects and paths are repository content inside the coordinator
 * context block: keep each on one line, and never let one close the block.
 */
const inline = (value: string) => value.replace(/\s+/g, " ").replaceAll("<", "‹").trim();

/** The notice lines, ending in a newline, for the coordinator context block. */
export function renderCheckoutUpdate(
  update: PendingCheckoutUpdate,
  upstream: string | null | undefined,
  changes: CheckoutChanges | null,
): string {
  const onlyUpstream = update.sources.size === 1 && update.sources.has("upstream");
  const branch = update.toBranch ?? "a detached HEAD";
  const range = `${short(update.fromCommit)} → ${short(update.toCommit)}`;
  let what: string;
  if (onlyUpstream) {
    what = `was fast-forwarded to its upstream${upstream ? ` ${upstream}` : ""} (${branch}, ${range})`;
  } else if (update.fromBranch && update.toBranch && update.fromBranch !== update.toBranch) {
    what = `moved from branch ${update.fromBranch} to ${update.toBranch} (${range})`;
  } else {
    const how = update.sources.has("upstream")
      ? "was updated from its upstream and changed in other ways too"
      : update.sources.has("switch")
        ? "was switched to another branch or commit"
        : update.sources.size === 1 && update.sources.has("external")
          ? "was changed outside Orkestrator"
          : "was updated";
    what = `${how} (${branch}, ${range})`;
  }
  let notice =
    `Checkout update: since your previous turn the project checkout ${what}. ` +
    `Anything you read or concluded about the code before may be out of date: check whether these changes bear on this request and re-read the files that matter before acting on them.\n`;
  if (changes && changes.totalCommits > 0) {
    notice += `New commits (${changes.totalCommits}, newest first):\n`;
    for (const commit of changes.commits) {
      notice += `- ${inline(commit.sha)} ${inline(commit.subject)}\n`;
    }
    if (changes.totalCommits > changes.commits.length) {
      notice += `- … and ${changes.totalCommits - changes.commits.length} more\n`;
    }
  }
  if (changes && changes.totalFiles > 0) {
    notice += `Changed files (${changes.totalFiles}):\n`;
    for (const file of changes.files) notice += `- ${inline(file)}\n`;
    if (changes.totalFiles > changes.files.length) {
      notice += `- … and ${changes.totalFiles - changes.files.length} more\n`;
    }
  }
  return notice;
}
