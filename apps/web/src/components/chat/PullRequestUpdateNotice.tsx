import { memo } from "react";
import { GitPullRequest } from "lucide-react";
import type { AgentMailNoticeTone } from "@orkestrator/protocol/agent-mail";
import {
  gitHubPullRequestUrl,
  isGitHubPullRequestRef,
} from "@orkestrator/protocol/github-pull-requests";
import { openPullRequestUrl, usePullRequestOpener } from "@/lib/pull-request-opener";
import type { PeerMailPresentation } from "@/lib/chat/native-message-types";
import { useCoordinatorPullRequestLink } from "@/lib/coordinator-pull-request-watch";
import { cn } from "@/lib/utils";

const TONE_CLASS: Record<AgentMailNoticeTone, string> = {
  success: "text-emerald-400",
  failure: "text-red-400",
  attention: "text-amber-400",
  info: "text-sky-400",
};

const STATE_LABELS: Record<string, string> = {
  "pr-merged": "merged",
  "pr-closed": "closed",
  "pr-checks-failed": "checks failing",
  "pr-conflicts": "merge conflicts",
  "pr-changes-requested": "changes requested",
  "pr-gone": "no longer available",
};

/** `owner/repo#number` from a watched pull request notice, or null. */
export function watchedPullRequestRef(
  id: string,
): { owner: string; repo: string; number: number } | null {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9]\d*)$/.exec(id);
  if (!match) return null;
  const ref = { owner: match[1], repo: match[2], number: Number(match[3]) };
  // Rejects `.` and `..`, which would traverse API paths.
  return isGitHubPullRequestRef(ref) ? ref : null;
}

/**
 * What changed, from the notice body's first line (`… in owner/repo: checks
 * passing, approved.`), falling back to the notice state.
 */
export function watchedPullRequestSummary(mail: Pick<PeerMailPresentation, "body" | "notice">) {
  const firstLine = mail.body.split("\n", 1)[0] ?? "";
  const match = / in [A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+: (.+?)\.?$/.exec(firstLine);
  return match?.[1] ?? (mail.notice ? STATE_LABELS[mail.notice.state] : undefined);
}

/**
 * A status change of a pull request the coordinator showed, as one quiet
 * line: `PR #12 updated · Title · checks passing`. Clicking the number opens
 * the pull request in the app. The coordinator reads the full notice; the
 * person only needs to know it happened.
 */
export const PullRequestUpdateNotice = memo(function PullRequestUpdateNotice({
  mail,
  timestampLabel,
}: {
  mail: PeerMailPresentation;
  timestampLabel?: string;
}) {
  const openPullRequest = usePullRequestOpener();
  const notice = mail.notice;
  const ref = notice ? watchedPullRequestRef(notice.resource.id) : null;
  const reportOpened = useCoordinatorPullRequestLink(ref ? gitHubPullRequestUrl(ref) : undefined);
  const title = notice?.resource.label;
  const summary = watchedPullRequestSummary(mail);
  const tone = notice?.tone ?? "info";
  const label = ref ? `PR #${ref.number}` : "PR";
  return (
    <div
      className="px-2 py-0.5 @sm:px-4"
      data-pr-update-notice="true"
      data-mail-state={notice?.state}
      data-mail-tone={tone}
    >
      <div
        data-transcript-item="pull-request-update"
        className="mx-auto flex min-w-0 max-w-3xl items-center gap-1.5 rounded-md px-1 text-[11px] leading-5 text-muted-foreground"
        title={mail.body.split("\n", 1)[0]}
      >
        <GitPullRequest className={cn("size-3 shrink-0", TONE_CLASS[tone])} aria-hidden="true" />
        <span data-agent-chat-search-content="true" className="flex min-w-0 items-baseline gap-1.5">
          {ref ? (
            <button
              type="button"
              onClick={(event) => {
                reportOpened();
                if (!(event.metaKey || event.ctrlKey) && openPullRequest(ref)) return;
                void openPullRequestUrl(gitHubPullRequestUrl(ref), { external: true });
              }}
              className="shrink-0 rounded font-medium text-foreground/75 hover:text-foreground hover:underline focus-hairline focus-hairline-outset"
            >
              {label}
            </button>
          ) : (
            <span className="shrink-0 font-medium text-foreground/75">{label}</span>
          )}
          <span className="shrink-0">updated</span>
          {title ? <span className="min-w-0 truncate text-foreground/60">· {title}</span> : null}
          {summary ? <span className="max-w-[45%] shrink-0 truncate">· {summary}</span> : null}
        </span>
        {timestampLabel ? (
          <span className="ml-auto shrink-0 pl-2 text-[10px] tabular-nums text-muted-foreground/70">
            {timestampLabel}
          </span>
        ) : null}
      </div>
    </div>
  );
});
