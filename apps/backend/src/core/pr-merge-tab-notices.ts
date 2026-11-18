/**
 * Tells an environment's open agent tabs that its pull request merged.
 *
 * Each tab gets one workflow notice through agent mail. It is not a prompt:
 * the transcript draws it as one quiet pull request line
 * (`PullRequestUpdateNotice`, resource `watched-pull-request`), while the
 * model reads the whole notice. Mail waits for a busy tab to go idle, so a
 * running turn is never interrupted. The text says no reply is needed, so an
 * agent with nothing waiting on the merge acknowledges it and stays quiet,
 * and one holding a step until the merge can take it.
 *
 * Exactly once per merge: `updateEnvironment` arms
 * `prMergeNoticePendingUrl` in the write that records the merge, and this
 * clears it once every tab has been sent its notice. Each tab's request id is
 * derived from the environment, tab and PR, so a retry after a crash between
 * the two replays the same message instead of sending another. A bounded
 * receipt on each mailbox is committed with the notice and outlives message
 * retention, so a delayed partial retry cannot resend a successful notice. Merges
 * recorded before the marker existed are never announced.
 */
import { createHash } from "node:crypto";
import {
  AGENT_MAIL_MAX_LIST_LIMIT,
  AgentMailError,
  type AgentMailNotice,
  type AgentMailRefusalCode,
} from "@orkestrator/protocol/agent-mail";
import {
  gitHubPullRequestUrl,
  parseGitHubPullRequestLink,
} from "@orkestrator/protocol/github-pull-requests";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import type { Environment } from "./models.js";
import type { StorageService } from "./storage.js";

const log = createLogger("pull-request");

/** Refusals that retrying cannot change for that one tab. */
const SKIP_TAB: ReadonlySet<AgentMailRefusalCode> = new Set([
  "policy-denied",
  "capability-denied",
  "recipient-superseded",
  "recipient-not-found",
  // Already sent: the same request id with the same content, or a record
  // retention has since pruned.
  "idempotency-conflict",
  "message-not-found",
]);

export type PrMergeTabNoticeStorage = Pick<
  StorageService,
  | "getEnvironment"
  | "updateEnvironment"
  | "ensureAgentMailDirectoryFresh"
  | "listAgentMailboxes"
  | "sendAgentMail"
>;

/** Subject, body and structured notice for one environment's merged PR. */
export function renderPrMergeTabNotice(
  environment: Pick<Environment, "branch" | "prBaseBranch">,
  prUrl: string,
): { subject: string; body: string; notice: AgentMailNotice } {
  const ref = parseGitHubPullRequestLink(prUrl);
  const branch = environment.branch ? ` \`${environment.branch}\`` : "";
  const base = environment.prBaseBranch ? ` into \`${environment.prBaseBranch}\`` : "";
  const body = [
    `The pull request for this environment's branch${branch} was merged${base}.`,
    `URL: ${prUrl}`,
    "",
    "This is an automatic notice from Orkestrator, not a message from the user, and it needs no reply. " +
      "If nothing you are doing depends on this merge, acknowledge it with ack_message and end your turn without writing anything to the user. " +
      "If something was waiting on the merge (a step you held back until it landed, follow-up work you said you would do afterwards, or a branch, ticket or note that should now be updated), do that now and tell the user briefly what you did.",
  ].join("\n");
  return {
    subject: ref ? `PR #${ref.number} merged` : "Pull request merged",
    body,
    notice: {
      ...(ref
        ? {
            pullRequest: {
              url: gitHubPullRequestUrl(ref),
              number: ref.number,
            },
          }
        : {}),
      resource: {
        kind: "watched-pull-request",
        // `owner/repo#number` is what the line links; a host it cannot parse
        // still draws the line, without the link.
        id: ref ? `${ref.owner}/${ref.repo}#${ref.number}` : prUrl.slice(0, 256),
      },
      state: "pr-merged",
      tone: "success",
    },
  };
}

function requestId(environmentId: string, tabId: string, prUrl: string): string {
  const digest = createHash("sha256").update(`${tabId}\0${prUrl}`).digest("hex").slice(0, 32);
  return `pr-merged:${environmentId}:${digest}`;
}

/**
 * Sends the pending merge notice of one environment to each of its open agent
 * tabs, then clears the marker. Safe to call repeatedly and concurrently; does
 * nothing when no notice is pending. A failure that a retry could fix leaves
 * the marker set for the PR monitor's next terminal follow-up.
 */
export async function deliverPrMergeTabNotices(
  storage: PrMergeTabNoticeStorage,
  environmentId: string,
): Promise<void> {
  const environment = await storage.getEnvironment(environmentId);
  const prUrl = environment?.prMergeNoticePendingUrl;
  if (!environment || !prUrl) return;
  const clear = () =>
    storage.updateEnvironment(
      environmentId,
      { prMergeNoticePendingUrl: null },
      (current) => current.prMergeNoticePendingUrl === prUrl,
    );
  // An environment on its way out (merge-and-delete, or a delete) has nothing
  // left for its tabs to do.
  if (
    environment.prState !== "merged" ||
    environment.prUrl !== prUrl ||
    environment.deletionRequestedAt ||
    environment.cleanupAfterMergeRequestedAt
  ) {
    await clear();
    return;
  }

  await storage.ensureAgentMailDirectoryFresh([environmentId]);
  const { mailboxes } = await storage.listAgentMailboxes({
    environmentId,
    limit: AGENT_MAIL_MAX_LIST_LIMIT,
  });
  // A build pipeline's workers are the pipeline's to brief, and a tab that
  // cannot take injected mail would only collect an inbox entry.
  const tabs = mailboxes.filter(
    (mailbox) => mailbox.kind !== "pipeline" && mailbox.capabilities.canInject,
  );
  const { subject, body, notice } = renderPrMergeTabNotice(environment, prUrl);
  let retry = false;
  for (const mailbox of tabs) {
    try {
      await storage.sendAgentMail(
        {
          kind: "system",
          projectId: environment.projectId,
          source: "workflow",
          resourceId: environmentId,
        },
        {
          requestId: requestId(environmentId, mailbox.tabId, prUrl),
          toEnvironmentId: environmentId,
          toTabId: mailbox.tabId,
          subject,
          body,
        },
        { notice, mergeNoticeUrl: prUrl },
      );
    } catch (error) {
      if (error instanceof AgentMailError && error.code === "messaging-disabled") {
        // The user turned agent messaging off; announcing later would be news
        // about something long past.
        await clear();
        return;
      }
      if (error instanceof AgentMailError && SKIP_TAB.has(error.code)) continue;
      retry = true;
      log.warn("merge-notice.send-failed", {
        environmentId,
        ...(error instanceof AgentMailError ? { code: error.code } : {}),
        error: formatLogError(error),
      });
    }
  }
  if (retry) throw new Error("Merge notice delivery remains pending");
  await clear();
}
