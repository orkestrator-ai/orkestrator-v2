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
 * merged or closed pull request is reported once (unless it was
 * already settled at its first reading) and then no longer watched. So is a
 * deleted one: a 404 or 410 is confirmed against the repository and issue
 * (`confirmGitHubPullRequestDeleted`), because a 404 alone may only mean the
 * token lost access. An unconfirmed 404 keeps the watch and backs off, until
 * it has lasted `WATCHED_PR_MISSING_GIVE_UP_MS`, when the watch is dropped
 * quietly. Other read failures keep the watch and back off.
 *
 * This is awareness, not ownership: a pull request a coordinator raised
 * through `create_pr` is followed by its `pull-request` association, which
 * this does not replace.
 */
import { createHash } from "node:crypto";
import {
  agentMailStatusBudgetKey,
  normalizeAgentMessagingSettings,
  type AgentMailNotice,
  type AgentMailNoticeTone,
} from "@orkestrator/protocol/agent-mail";
import {
  gitHubPullRequestKey,
  gitHubPullRequestUrl,
  parseGitHubPullRequestLink,
  type GitHubPullRequestRef,
} from "@orkestrator/protocol/github-pull-requests";
import { parseGitHubRepositoryRemote } from "@orkestrator/protocol/github-repository";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { CoordinatorNoticeRouter } from "./coordinator-notice-router.js";
import { GitHubApiError } from "./github.js";
import type { GitHubCliSelection } from "./github-cli-binary.js";
import { resolveGitHubToken } from "./github-credentials.js";
import {
  confirmGitHubPullRequestDeleted,
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
/**
 * How long a pull request may answer "not found" without GitHub confirming a
 * deletion before the watch gives up on it. An explicit open watches it again.
 */
export const WATCHED_PR_MISSING_GIVE_UP_MS = 7 * 24 * 60 * 60 * 1_000;
/** The change phrase of a pull request GitHub confirmed deleted. */
export const WATCHED_PR_DELETED_PHRASE = "deleted from GitHub";
/** Same hold as other status notices, so changes landing together arrive together. */
const WATCHED_PR_COALESCE_MS = 10_000;
const MAX_TITLE_CHARS = 120;

export type WatchPullRequestOutcome =
  | { watched: true; added: boolean }
  | {
      watched: false;
      reason:
        "other-repository" | "no-repository" | "no-coordinator" | "settled" | "already-followed";
    };

export type WatchPullRequestSource = WatchedPullRequest["source"];

export interface CoordinatorPullRequestWatchOptions {
  storage: Pick<
    StorageService,
    "watchedPullRequests" | "getProject" | "loadProjects" | "loadConfig" | "sendAgentMail"
  > & {
    coordinators: Pick<
      CoordinatorsStorage,
      | "getCoordinatorWorkspace"
      | "getCoordinatorReconciliationState"
      | "listCoordinatorWorkflowAssociations"
    >;
  };
  /** Who hears a notice; without one, this machine's coordinator and no new sessions. */
  noticeRouter?: CoordinatorNoticeRouter;
  readStatus?: (token: string, ref: GitHubPullRequestRef) => Promise<GitHubPullRequestStatus>;
  /** After a 404 or 410: true only when GitHub positively shows the pull request is gone. */
  confirmDeleted?: (token: string, ref: GitHubPullRequestRef) => Promise<boolean>;
  /** The Settings GitHub credential; undefined when none is configured. */
  token?: () => Promise<string | undefined>;
  /** The backend's `gh`, which reads the host login when `token` is left out. */
  gitHubCli?: GitHubCliSelection;
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
          : status.checksState === "neutral"
            ? "neutral"
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
  neutral: "checks neutral or skipped",
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
  if (
    previous.conflicts !== null &&
    next.conflicts !== null &&
    previous.conflicts !== next.conflicts
  ) {
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
      pullRequest: { url, number: entry.number, ...(label ? { title: label } : {}) },
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
  private readonly confirmDeleted: NonNullable<
    CoordinatorPullRequestWatchOptions["confirmDeleted"]
  >;
  private readonly token: NonNullable<CoordinatorPullRequestWatchOptions["token"]>;
  private readonly now: () => number;
  private readonly coalesceMs: number;
  private sweeping: Promise<void> | null = null;
  private readonly baselined = new Set<string>();
  private readonly router: CoordinatorNoticeRouter;

  constructor(options: CoordinatorPullRequestWatchOptions) {
    this.storage = options.storage;
    this.router = options.noticeRouter ?? new CoordinatorNoticeRouter(options.storage);
    this.readStatus =
      options.readStatus ?? ((token, ref) => getGitHubPullRequestStatus(token, ref));
    this.confirmDeleted =
      options.confirmDeleted ?? ((token, ref) => confirmGitHubPullRequestDeleted(token, ref));
    this.token =
      options.token ??
      (async () => resolveGitHubToken((await this.storage.loadConfig()).global, options.gitHubCli));
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
    if (await this.isFollowed(projectId, gitHubPullRequestKey(ref))) {
      return { watched: false, reason: "already-followed" };
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
    const messaging = normalizeAgentMessagingSettings(config.global.agentMessaging);
    const notify = messaging.enabled && messaging.coordinatorStatusWakes !== "off";
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

  /** Reuse the host credential and conditional GitHub reader for status-card labels. */
  async metadata(url: string) {
    const parsed = parseGitHubPullRequestLink(url);
    if (!parsed) return undefined;
    const ref = { owner: parsed.owner, repo: parsed.repo, number: parsed.number };
    const title = await this.token()
      .then(async (token) =>
        token ? boundedTitle((await this.readStatus(token, ref)).title) : undefined,
      )
      .catch(() => undefined);
    return { url: gitHubPullRequestUrl(ref), number: ref.number, ...(title ? { title } : {}) };
  }

  /** Read one watched pull request; true when GitHub asked us to stop for now. */
  private async observe(
    projectId: string,
    entry: WatchedPullRequest,
    token: string,
    notify: boolean,
  ): Promise<boolean> {
    if (await this.isFollowed(projectId, entry.key)) {
      this.storage.watchedPullRequests.updateWatchedPullRequest(
        projectId,
        entry.key,
        new Date(this.now()),
        () => ({ kind: "settle" }),
      );
      return false;
    }
    // Advance due order even if delivery fails. Keep the previous reading until
    // delivery succeeds so the same deterministic notice is retried next interval.
    this.recordChecked(projectId, entry.key);
    const ref = { owner: entry.owner, repo: entry.repo, number: entry.number };
    let status: GitHubPullRequestStatus;
    try {
      status = await this.readStatus(token, ref);
    } catch (error) {
      this.recordChecked(projectId, entry.key);
      if (error instanceof GitHubApiError && error.code === "rate-limit") return true;
      const missing =
        error instanceof GitHubApiError && (error.status === 404 || error.status === 410);
      if (missing && (await this.confirmDeleted(token, ref).catch(() => false))) {
        await this.settleDeleted(projectId, entry, notify);
        return false;
      }
      log.debug("pr-watch.read-failed", {
        code: error instanceof GitHubApiError ? error.code : "error",
      });
      if (missing) this.recordMissing(projectId, entry.key);
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
    this.baselined.add(`${projectId}:${entry.key}:${entry.incarnationId ?? ""}`);
    const checkedAt = new Date(this.now()).toISOString();
    this.storage.watchedPullRequests.updateWatchedPullRequest(
      projectId,
      entry.key,
      new Date(this.now()),
      (current) => {
        if (settled) return { kind: "settle" };
        const next: WatchedPullRequest = {
          ...current,
          ...(title ? { title } : {}),
          reading,
          checkedAt,
          notices: Math.max(current.notices, notices),
        };
        // A successful reading ends any run of "not found" answers.
        delete next.missingSince;
        return { kind: "keep", entry: next };
      },
    );
    return false;
  }

  /**
   * GitHub confirmed the pull request is gone: tell the coordinator, when it
   * had a baseline to compare against, and stop watching. A failed delivery
   * throws before the settle, so the next interval retries the same notice.
   */
  private async settleDeleted(
    projectId: string,
    entry: WatchedPullRequest,
    notify: boolean,
  ): Promise<void> {
    if (entry.reading && notify) {
      await this.deliver(
        projectId,
        entry,
        entry.title,
        [WATCHED_PR_DELETED_PHRASE],
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
    log.debug("pr-watch.removed", { projectId, reason: "deleted" });
  }

  /**
   * An unconfirmed "not found": keep the watch and its baseline, since the
   * token may only have lost access, but give up once it has lasted
   * `WATCHED_PR_MISSING_GIVE_UP_MS` so a pull request lost with its
   * repository is not read forever.
   */
  private recordMissing(projectId: string, key: string): void {
    const nowMs = this.now();
    let removed = false;
    this.storage.watchedPullRequests.updateWatchedPullRequest(
      projectId,
      key,
      new Date(nowMs),
      (current) => {
        const since = current.missingSince ? Date.parse(current.missingSince) : Number.NaN;
        if (Number.isFinite(since) && nowMs - since >= WATCHED_PR_MISSING_GIVE_UP_MS) {
          removed = true;
          return { kind: "settle" };
        }
        return {
          kind: "keep",
          entry: {
            ...current,
            missingSince: Number.isFinite(since)
              ? current.missingSince!
              : new Date(nowMs).toISOString(),
          },
        };
      },
    );
    if (removed) log.debug("pr-watch.removed", { projectId, reason: "unreadable" });
  }

  private async isFollowed(projectId: string, key: string): Promise<boolean> {
    const associations =
      await this.storage.coordinators.listCoordinatorWorkflowAssociations(projectId);
    return associations.some((association) => {
      if (
        association.kind !== "pull-request" ||
        association.pending ||
        association.terminalNotifiedAt
      )
        return false;
      const ref = parseGitHubPullRequestLink(association.pullRequest?.prUrl ?? "");
      return ref !== null && gitHubPullRequestKey(ref) === key;
    });
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
   * Put one notice with the coordinator that should hear it; see
   * `CoordinatorNoticeRouter`. A change seen after this backend's first sweep is
   * a new event and starts a coordinator if none is running. The first sweep
   * compares against a reading from before the restart, so it starts nothing:
   * with no main open the change is recorded without a notice. The request id is
   * fixed by the pull request lifecycle, notice count and reading, so a retry after
   * a crash replays. Legacy watches retain their original request namespace until
   * they settle.
   */
  private deliver(
    projectId: string,
    entry: WatchedPullRequest,
    title: string | undefined,
    changes: readonly string[],
    noticeState: { state: string; tone: AgentMailNoticeTone },
    signature: string,
  ): Promise<boolean> {
    const { subject, body, notice } = renderWatchedPullRequestNotice(
      entry,
      title,
      changes,
      noticeState,
    );
    const key = `${entry.key}:${entry.incarnationId ? `${entry.incarnationId}:` : ""}${entry.notices + 1}:${signature}`;
    return this.router.deliver({
      projectId,
      createSession: this.baselined.has(`${projectId}:${entry.key}:${entry.incarnationId ?? ""}`),
      resourceId: entry.key,
      requestId: (mainId) => `pr-watch:${mainId}:${key}`,
      upwardRequestId: `pr-watch:${projectId}:${key}`,
      subject,
      body,
      notice,
      statusBudgetKey: agentMailStatusBudgetKey("watched-pull-request", entry.key),
      coalesceMs: this.coalesceMs,
    });
  }
}
