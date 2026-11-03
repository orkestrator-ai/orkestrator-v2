/**
 * Pull requests a coordinator has seen: watched until they settle.
 *
 * When a coordinator conversation renders a link to a pull request of its
 * project's GitHub repository, or the user opens one from it, the renderer
 * calls `watch_coordinator_pull_request` and the pull request joins the
 * project's watch (`storage-watched-pull-requests.ts`). The coordinator repair
 * sweep (every 60 s, beside the PR follows of `coordinator-status-wakes.ts`)
 * reads a few due pull requests each pass through the GitHub REST client and
 * its conditional cache. The first reading is the baseline; every later change
 * of state (open, draft, merged, closed), checks, merge conflicts or review
 * decision is sent to the project's main coordinator as a small workflow
 * notice (resource `watched-pull-request`), which the transcript draws as one
 * line rather than a mail tile. The notice says no action is expected. A
 * merged, closed or vanished pull request is reported once (unless it was
 * already settled at its first reading) and then no longer watched.
 *
 * This is awareness, not ownership: a pull request a coordinator raised
 * through `create_pr` is followed by its `pull-request` association, which
 * this does not replace.
 */
import { createHash } from "node:crypto";
import {
  AgentMailError,
  agentMailStatusBudgetKey,
  normalizeAgentMessagingSettings,
  type AgentMailNotice,
  type AgentMailNoticeTone,
} from "@orkestrator/protocol/agent-mail";
import {
  coordinatorMainConversation,
  coordinatorRuntimeId,
} from "@orkestrator/protocol/coordinator";
import {
  gitHubPullRequestKey,
  gitHubPullRequestUrl,
  type GitHubPullRequestRef,
} from "@orkestrator/protocol/github-pull-requests";
import { parseGitHubRepositoryRemote } from "@orkestrator/protocol/github-repository";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { GitHubApiError } from "./github.js";
import { resolveGitHubToken } from "./github-credentials.js";
import {
  getGitHubPullRequestStatus,
  type GitHubPullRequestStatus,
} from "./github-pull-requests.js";
import type { CoordinatorsStorage, StorageService } from "./storage.js";
import type {
  WatchedPullRequest,
  WatchedPullRequestReading,
} from "./storage-watched-pull-requests.js";

const log = createLogger("coordinator");

/** How often one watched pull request is read at most. */
export const WATCHED_PR_POLL_INTERVAL_MS = 120_000;
/** Reads per sweep, so a large watch spreads over several sweeps instead of bursting. */
export const WATCHED_PR_MAX_READS_PER_SWEEP = 15;
/** A watched pull request seen again refreshes `lastSeenAt` at most this often. */
export const WATCHED_PR_TOUCH_AFTER_MS = 60 * 60 * 1_000;
/** Same hold as other status notices, so changes landing together arrive together. */
const WATCHED_PR_COALESCE_MS = 10_000;
const MAX_TITLE_CHARS = 120;

export type WatchPullRequestOutcome =
  | { watched: true; added: boolean }
  | {
      watched: false;
      reason: "other-repository" | "no-repository" | "no-coordinator" | "settled";
    };

export type WatchPullRequestSource = WatchedPullRequest["source"];

export interface CoordinatorPullRequestWatchOptions {
  storage: Pick<
    StorageService,
    "watchedPullRequests" | "getProject" | "loadProjects" | "loadConfig" | "sendAgentMail"
  > & { coordinators: Pick<CoordinatorsStorage, "getCoordinatorWorkspace"> };
  readStatus?: (token: string, ref: GitHubPullRequestRef) => Promise<GitHubPullRequestStatus>;
  /** The Settings GitHub credential; undefined when none is configured. */
  token?: () => Promise<string | undefined>;
  now?: () => number;
  coalesceMs?: number;
}

/** The comparable reading of a GitHub status. */
export function watchedPullRequestReading(
  status: GitHubPullRequestStatus,
  previous?: WatchedPullRequestReading,
): WatchedPullRequestReading {
  const state = status.state === "open" ? (status.isDraft ? "draft" : "open") : status.state;
  const checks =
    status.checksState === "failure"
      ? "failing"
      : status.checksState === "success"
        ? "passing"
        : status.checksState === "pending"
          ? "pending"
          : "none";
  const computed =
    status.mergeability === "dirty"
      ? true
      : status.mergeability === "unknown" || status.mergeability === "unavailable"
        ? null
        : false;
  // GitHub recomputes mergeability after every push; an unknown reading of an
  // open pull request keeps the last one rather than flapping.
  const conflicts =
    computed === null && status.state === "open" ? (previous?.conflicts ?? null) : computed;
  return { state, checks, conflicts, review: status.reviewDecision };
}

const CHECK_PHRASES: Record<WatchedPullRequestReading["checks"], string> = {
  passing: "checks passing",
  failing: "checks failing",
  pending: "checks running",
  none: "no checks reported",
};

/** What changed between two readings, as short phrases; empty when nothing did. */
export function describeWatchedPullRequestChanges(
  previous: WatchedPullRequestReading,
  next: WatchedPullRequestReading,
): string[] {
  const changes: string[] = [];
  if (previous.state !== next.state) {
    if (next.state === "merged") changes.push("merged");
    else if (next.state === "closed") changes.push("closed without merging");
    else if (previous.state === "closed" || previous.state === "merged") changes.push("reopened");
    else if (next.state === "draft") changes.push("converted to draft");
    else changes.push("marked ready for review");
  }
  // A settled pull request's checks, conflicts and reviews are not news.
  if (next.state === "merged" || next.state === "closed") return changes;
  if (previous.checks !== next.checks) changes.push(CHECK_PHRASES[next.checks]);
  if (next.conflicts !== null && previous.conflicts !== next.conflicts) {
    changes.push(next.conflicts ? "has merge conflicts" : "merge conflicts resolved");
  }
  if (previous.review !== next.review) {
    changes.push(
      next.review === "approved"
        ? "approved"
        : next.review === "changes-requested"
          ? "changes requested"
          : "review decision cleared",
    );
  }
  return changes;
}

/** The notice's machine state and tone for a change to `next`. */
export function watchedPullRequestNoticeState(
  previous: WatchedPullRequestReading,
  next: WatchedPullRequestReading,
): { state: string; tone: AgentMailNoticeTone } {
  if (next.state === "merged") return { state: "pr-merged", tone: "success" };
  if (next.state === "closed") return { state: "pr-closed", tone: "info" };
  if (next.checks === "failing" && previous.checks !== "failing")
    return { state: "pr-checks-failed", tone: "failure" };
  if (next.conflicts === true && previous.conflicts !== true)
    return { state: "pr-conflicts", tone: "attention" };
  if (next.review === "changes-requested" && previous.review !== "changes-requested")
    return { state: "pr-changes-requested", tone: "attention" };
  return { state: "pr-updated", tone: "info" };
}

function boundedTitle(title: string | undefined): string | undefined {
  const line = title?.replace(/\s+/g, " ").trim();
  if (!line) return undefined;
  return line.length > MAX_TITLE_CHARS ? `${line.slice(0, MAX_TITLE_CHARS - 1)}…` : line;
}

function readingSignature(reading: WatchedPullRequestReading | "gone"): string {
  return createHash("sha256").update(JSON.stringify(reading)).digest("hex").slice(0, 16);
}

/** Subject, body and structured notice for one change; content-free beyond the PR's own title. */
export function renderWatchedPullRequestNotice(
  entry: Pick<WatchedPullRequest, "key" | "owner" | "repo" | "number">,
  title: string | undefined,
  changes: readonly string[],
  noticeState: { state: string; tone: AgentMailNoticeTone },
): { subject: string; body: string; notice: AgentMailNotice } {
  const label = boundedTitle(title);
  const url = gitHubPullRequestUrl(entry);
  const summary = changes.join(", ");
  const subject = `PR #${entry.number} updated${label ? `: ${label}` : ""}`.slice(0, 160);
  const body = [
    `Pull request #${entry.number}${label ? ` "${label}"` : ""} in ${entry.owner}/${entry.repo}: ${summary}.`,
    `URL: ${url}`,
    "",
    "This pull request is watched because it appeared in this coordinator conversation. This is for awareness only: no action is expected unless the change affects work you are tracking. If it does not, acknowledge it briefly and finish the turn.",
  ].join("\n");
  return {
    subject,
    body,
    notice: {
      resource: {
        kind: "watched-pull-request",
        id: entry.key,
        ...(label ? { label } : {}),
      },
      state: noticeState.state,
      tone: noticeState.tone,
    },
  };
}

/** Watches pull requests coordinators have seen; see the module comment. */
export class CoordinatorPullRequestWatches {
  private readonly storage: CoordinatorPullRequestWatchOptions["storage"];
  private readonly readStatus: NonNullable<CoordinatorPullRequestWatchOptions["readStatus"]>;
  private readonly token: NonNullable<CoordinatorPullRequestWatchOptions["token"]>;
  private readonly now: () => number;
  private readonly coalesceMs: number;
  private sweeping: Promise<void> | null = null;

  constructor(options: CoordinatorPullRequestWatchOptions) {
    this.storage = options.storage;
    this.readStatus =
      options.readStatus ?? ((token, ref) => getGitHubPullRequestStatus(token, ref));
    this.token =
      options.token ?? (async () => resolveGitHubToken((await this.storage.loadConfig()).global));
    this.now = options.now ?? (() => Date.now());
    this.coalesceMs = options.coalesceMs ?? WATCHED_PR_COALESCE_MS;
  }

  /**
   * Watch a pull request a coordinator conversation of `projectId` rendered
   * or opened. Only the project's own GitHub repository is watched, and only
   * once the project has a coordinator.
   */
  async watch(
    projectId: string,
    ref: GitHubPullRequestRef,
    source: WatchPullRequestSource,
  ): Promise<WatchPullRequestOutcome> {
    const project = await this.storage.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const repository = parseGitHubRepositoryRemote(project.gitUrl ?? "");
    if (!repository.ok) return { watched: false, reason: "no-repository" };
    if (
      repository.repository.owner.toLowerCase() !== ref.owner.toLowerCase() ||
      repository.repository.name.toLowerCase() !== ref.repo.toLowerCase()
    ) {
      return { watched: false, reason: "other-repository" };
    }
    if (!(await this.storage.coordinators.getCoordinatorWorkspace(projectId))) {
      return { watched: false, reason: "no-coordinator" };
    }
    const result = this.storage.watchedPullRequests.watchPullRequest(
      projectId,
      {
        key: gitHubPullRequestKey(ref),
        owner: repository.repository.owner,
        repo: repository.repository.name,
        number: ref.number,
        source,
      },
      new Date(this.now()),
      WATCHED_PR_TOUCH_AFTER_MS,
    );
    if (result.watched && result.added) {
      log.debug("pr-watch.added", { projectId, source });
    }
    return result;
  }

  /** Read the due watched pull requests and report changes. One sweep at a time. */
  sweep(): Promise<void> {
    this.sweeping ??= this.sweepOnce().finally(() => {
      this.sweeping = null;
    });
    return this.sweeping;
  }

  private async sweepOnce(): Promise<void> {
    const projects = await this.storage.loadProjects();
    const nowMs = this.now();
    const due: Array<{ projectId: string; entry: WatchedPullRequest }> = [];
    for (const project of projects) {
      for (const entry of this.storage.watchedPullRequests.listWatchedPullRequests(project.id)) {
        const checked = entry.checkedAt ? Date.parse(entry.checkedAt) : Number.NaN;
        if (Number.isFinite(checked) && nowMs - checked < WATCHED_PR_POLL_INTERVAL_MS) continue;
        due.push({ projectId: project.id, entry });
      }
    }
    if (due.length === 0) return;
    const token = await this.token().catch(() => undefined);
    if (!token) return;
    const config = await this.storage.loadConfig();
    const notify =
      normalizeAgentMessagingSettings(config.global.agentMessaging).coordinatorStatusWakes !==
      "off";
    // Never read first, then longest unread.
    due.sort(
      (a, b) =>
        (a.entry.checkedAt ? Date.parse(a.entry.checkedAt) : 0) -
        (b.entry.checkedAt ? Date.parse(b.entry.checkedAt) : 0),
    );
    for (const { projectId, entry } of due.slice(0, WATCHED_PR_MAX_READS_PER_SWEEP)) {
      const stop = await this.observe(projectId, entry, token, notify).catch((error: unknown) => {
        log.warn("pr-watch.observe-failed", { error: formatLogError(error, { stack: false }) });
        return false;
      });
      if (stop) break;
    }
  }

  /** Read one watched pull request; true when GitHub asked us to stop for now. */
  private async observe(
    projectId: string,
    entry: WatchedPullRequest,
    token: string,
    notify: boolean,
  ): Promise<boolean> {
    const ref = { owner: entry.owner, repo: entry.repo, number: entry.number };
    let status: GitHubPullRequestStatus;
    try {
      status = await this.readStatus(token, ref);
    } catch (error) {
      if (error instanceof GitHubApiError && error.code === "not-found") {
        await this.settleGone(projectId, entry, notify);
        return false;
      }
      this.recordChecked(projectId, entry.key);
      if (error instanceof GitHubApiError && error.code === "rate-limit") return true;
      log.debug("pr-watch.read-failed", {
        code: error instanceof GitHubApiError ? error.code : "error",
      });
      return false;
    }
    const previous = entry.reading;
    const reading = watchedPullRequestReading(status, previous);
    const title = boundedTitle(status.title) ?? entry.title;
    const settled = reading.state === "merged" || reading.state === "closed";
    const changes = previous ? describeWatchedPullRequestChanges(previous, reading) : [];
    let notices = entry.notices;
    if (previous && changes.length > 0 && notify) {
      const delivered = await this.deliver(
        projectId,
        entry,
        title,
        changes,
        watchedPullRequestNoticeState(previous, reading),
        readingSignature(reading),
      );
      if (delivered) notices += 1;
    }
    const checkedAt = new Date(this.now()).toISOString();
    this.storage.watchedPullRequests.updateWatchedPullRequest(
      projectId,
      entry.key,
      new Date(this.now()),
      (current) =>
        settled
          ? { kind: "settle" }
          : {
              kind: "keep",
              entry: {
                ...current,
                ...(title ? { title } : {}),
                reading,
                checkedAt,
                notices: Math.max(current.notices, notices),
              },
            },
    );
    return false;
  }

  /** GitHub no longer has it (deleted, or the repository is gone): report once and stop. */
  private async settleGone(
    projectId: string,
    entry: WatchedPullRequest,
    notify: boolean,
  ): Promise<void> {
    if (entry.reading && notify) {
      await this.deliver(
        projectId,
        entry,
        entry.title,
        ["no longer available on GitHub, so it is no longer watched"],
        { state: "pr-gone", tone: "info" },
        readingSignature("gone"),
      );
    }
    this.storage.watchedPullRequests.updateWatchedPullRequest(
      projectId,
      entry.key,
      new Date(this.now()),
      () => ({ kind: "settle" }),
    );
  }

  private recordChecked(projectId: string, key: string): void {
    const checkedAt = new Date(this.now()).toISOString();
    this.storage.watchedPullRequests.updateWatchedPullRequest(
      projectId,
      key,
      new Date(this.now()),
      (current) => ({ kind: "keep", entry: { ...current, checkedAt } }),
    );
  }

  /**
   * Put one notice in the main coordinator's inbox. Like other status
   * notices it does not start a coordinator: with no main conversation open
   * the change is recorded without a notice. The request id is fixed by the
   * pull request, notice count and reading, so a retry after a crash replays.
   */
  private async deliver(
    projectId: string,
    entry: WatchedPullRequest,
    title: string | undefined,
    changes: readonly string[],
    noticeState: { state: string; tone: AgentMailNoticeTone },
    signature: string,
  ): Promise<boolean> {
    const workspace = await this.storage.coordinators.getCoordinatorWorkspace(projectId);
    const main = workspace ? coordinatorMainConversation(workspace) : undefined;
    if (!workspace || !main) return false;
    const { subject, body, notice } = renderWatchedPullRequestNotice(
      entry,
      title,
      changes,
      noticeState,
    );
    try {
      await this.storage.sendAgentMail(
        { kind: "system", projectId, source: "workflow", resourceId: entry.key },
        {
          requestId: `pr-watch:${main.id}:${entry.key}:${entry.notices + 1}:${signature}`,
          toEnvironmentId: coordinatorRuntimeId(workspace.id, main.id),
          toTabId: main.tabId,
          subject,
          body,
        },
        {
          notice,
          statusBudgetKey: agentMailStatusBudgetKey("watched-pull-request", entry.key),
          coalesceMs: this.coalesceMs,
        },
      );
      return true;
    } catch (error) {
      if (error instanceof AgentMailError && error.code === "idempotency-conflict") return true;
      throw error;
    }
  }
}
