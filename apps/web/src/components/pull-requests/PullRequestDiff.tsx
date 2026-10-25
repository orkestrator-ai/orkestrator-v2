import { Fragment, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import type { ChangeDiffLine } from "@orkestrator/protocol/change-resources";
import type {
  GitHubPullRequestFile,
  GitHubPullRequestRef,
  GitHubPullRequestReviewThread,
} from "@orkestrator/protocol/github-pull-requests";
import { cn } from "@/lib/utils";
import { usePullRequestsStore } from "@/stores/pullRequestsStore";
import { PullRequestReviewThread } from "./PullRequestReviewThread";
import { CommentComposer } from "./pull-request-shared";

export type DiffSide = "LEFT" | "RIGHT";

/** Where a new comment on this line anchors: RIGHT/newLine unless the line was removed. */
export function commentAnchorForLine(
  line: ChangeDiffLine,
): { side: DiffSide; line: number } | null {
  if (line.type === "remove")
    return line.oldLine === null ? null : { side: "LEFT", line: line.oldLine };
  if (line.type === "add" || line.type === "context") {
    return line.newLine === null ? null : { side: "RIGHT", line: line.newLine };
  }
  return null;
}

function lineKey(hunkIndex: number, lineIndex: number): string {
  return `${hunkIndex}:${lineIndex}`;
}

export type AnchoredThreads = {
  /** Threads per rendered line, keyed `${hunkIndex}:${lineIndex}`. */
  byLine: Map<string, GitHubPullRequestReviewThread[]>;
  /** Outdated threads, and current threads whose line is outside the shown hunks. */
  unplaced: GitHubPullRequestReviewThread[];
};

/**
 * Places each thread beneath the diff line it anchors to: a RIGHT thread on
 * the line whose new number matches, a LEFT thread on the line whose old
 * number matches (remove or context lines). Outdated threads never anchor.
 */
export function anchorThreads(
  file: Pick<GitHubPullRequestFile, "hunks">,
  threads: GitHubPullRequestReviewThread[],
): AnchoredThreads {
  const pending = new Map<string, GitHubPullRequestReviewThread[]>();
  for (const thread of threads) {
    if (thread.isOutdated || thread.line === null) continue;
    const key = `${thread.side}:${thread.line}`;
    pending.set(key, [...(pending.get(key) ?? []), thread]);
  }
  const byLine = new Map<string, GitHubPullRequestReviewThread[]>();
  const placed = new Set<string>();
  file.hunks.forEach((hunk, hunkIndex) => {
    hunk.lines.forEach((line, lineIndex) => {
      const candidates: string[] = [];
      if ((line.type === "add" || line.type === "context") && line.newLine !== null) {
        candidates.push(`RIGHT:${line.newLine}`);
      }
      if ((line.type === "remove" || line.type === "context") && line.oldLine !== null) {
        candidates.push(`LEFT:${line.oldLine}`);
      }
      for (const candidate of candidates) {
        const found = pending.get(candidate);
        if (!found || placed.has(candidate)) continue;
        placed.add(candidate);
        const key = lineKey(hunkIndex, lineIndex);
        byLine.set(key, [...(byLine.get(key) ?? []), ...found]);
      }
    });
  });
  const placedIds = new Set(Array.from(byLine.values()).flatMap((list) => list.map((t) => t.id)));
  return { byLine, unplaced: threads.filter((thread) => !placedIds.has(thread.id)) };
}

function lineClass(line: ChangeDiffLine): string {
  return cn(
    line.type === "add" && "bg-success/12",
    line.type === "remove" && "bg-failure/12",
    line.type === "no-newline" && "italic text-muted-foreground",
  );
}

function lineSign(line: ChangeDiffLine): string {
  if (line.type === "add") return "+";
  if (line.type === "remove") return "-";
  return " ";
}

/**
 * Unified diff of one pull request file with line-number gutters and inline
 * review threads. New comments go through `addReviewComment` at `commitId`.
 */
export function PullRequestDiff({
  pullRequest,
  file,
  threads,
  commitId,
  canComment,
}: {
  pullRequest: GitHubPullRequestRef;
  file: GitHubPullRequestFile;
  threads: GitHubPullRequestReviewThread[];
  commitId: string;
  canComment: boolean;
}) {
  const addReviewComment = usePullRequestsStore((state) => state.addReviewComment);
  const [composerAt, setComposerAt] = useState<{
    key: string;
    commitId: string;
    path: string;
    side: DiffSide;
    line: number;
  } | null>(null);
  const anchored = useMemo(() => anchorThreads(file, threads), [file, threads]);
  const gutterWidth = useMemo(() => {
    let max = 0;
    for (const hunk of file.hunks) {
      max = Math.max(max, hunk.oldStart + hunk.oldLines, hunk.newStart + hunk.newLines);
    }
    return `${Math.max(2, String(max).length) + 1}ch`;
  }, [file.hunks]);

  if (file.hunks.length === 0) {
    return <div className="px-3 py-2 text-xs text-muted-foreground">No textual changes.</div>;
  }

  return (
    <div data-testid="pull-request-diff" className="font-mono text-xs leading-5">
      {file.hunks.map((hunk, hunkIndex) => (
        <Fragment key={hunkIndex}>
          <div className="bg-sky-500/10 px-3 py-0.5 break-all whitespace-pre-wrap text-sky-300/90">
            {hunk.header}
          </div>
          {hunk.lines.map((line, lineIndex) => {
            const key = lineKey(hunkIndex, lineIndex);
            const lineThreads = anchored.byLine.get(key);
            const anchor = canComment ? commentAnchorForLine(line) : null;
            const composerOpen = composerAt?.key === key && anchor !== null;
            return (
              <Fragment key={lineIndex}>
                <div
                  data-testid="diff-line"
                  data-line-type={line.type}
                  data-old-line={line.oldLine ?? undefined}
                  data-new-line={line.newLine ?? undefined}
                  className={cn("group relative flex", lineClass(line))}
                >
                  <span
                    className="shrink-0 pr-1 text-right text-muted-foreground/60 select-none"
                    style={{ width: gutterWidth }}
                  >
                    {line.type === "no-newline" ? "" : (line.oldLine ?? "")}
                  </span>
                  <span
                    className="shrink-0 pr-1 text-right text-muted-foreground/60 select-none"
                    style={{ width: gutterWidth }}
                  >
                    {line.type === "no-newline" ? "" : (line.newLine ?? "")}
                  </span>
                  <span
                    className={cn(
                      "relative w-4 shrink-0 text-center select-none",
                      line.type === "add" && "text-success",
                      line.type === "remove" && "text-failure",
                    )}
                  >
                    {lineSign(line)}
                    {anchor && (
                      <button
                        type="button"
                        aria-label={`Comment on ${anchor.side === "LEFT" ? "old" : "new"} line ${anchor.line}`}
                        onClick={() => setComposerAt({ key, commitId, path: file.path, ...anchor })}
                        className="absolute top-0.5 left-0 flex size-4 items-center justify-center rounded bg-primary text-primary-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                      >
                        <Plus className="size-3" />
                      </button>
                    )}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 flex-1 pr-3 break-all whitespace-pre-wrap",
                      line.type === "context" && "text-foreground/70",
                    )}
                  >
                    {line.type === "no-newline" ? "\\ No newline at end of file" : line.text}
                  </span>
                </div>
                {(lineThreads || composerOpen) && (
                  <div
                    data-testid="diff-line-threads"
                    data-anchor-key={key}
                    className="space-y-2 border-y border-border/50 bg-background px-2 py-2 font-sans"
                  >
                    {lineThreads?.map((thread) => (
                      <PullRequestReviewThread
                        key={thread.id}
                        pullRequest={pullRequest}
                        thread={thread}
                        canReply={canComment}
                      />
                    ))}
                    {composerOpen && composerAt && (
                      <div className="rounded-lg border border-border bg-card/60 p-2">
                        {composerAt.commitId !== commitId && (
                          <p className="mb-2 font-sans text-xs text-muted-foreground">
                            Commenting on the original revision {composerAt.commitId.slice(0, 7)},{" "}
                            {composerAt.path}, {composerAt.side} line {composerAt.line}.
                          </p>
                        )}
                        <CommentComposer
                          autoFocus
                          placeholder="Add a review comment"
                          ariaLabel="Review comment"
                          submitLabel="Add comment"
                          onCancel={() => setComposerAt(null)}
                          onSubmit={async (body) => {
                            await addReviewComment(pullRequest, composerAt.commitId, {
                              path: composerAt.path,
                              line: composerAt.line,
                              side: composerAt.side,
                              body,
                            });
                            setComposerAt(null);
                          }}
                        />
                      </div>
                    )}
                  </div>
                )}
              </Fragment>
            );
          })}
        </Fragment>
      ))}
      {anchored.unplaced.length > 0 && (
        <div
          data-testid="diff-unplaced-threads"
          className="space-y-2 border-t border-border/50 px-2 py-2 font-sans"
        >
          <div className="text-[11px] font-medium text-muted-foreground">
            {anchored.unplaced.every((thread) => thread.isOutdated)
              ? "Outdated comments"
              : "Comments outside the shown diff"}
          </div>
          {anchored.unplaced.map((thread) => (
            <PullRequestReviewThread
              key={thread.id}
              pullRequest={pullRequest}
              thread={thread}
              canReply={canComment}
            />
          ))}
        </div>
      )}
    </div>
  );
}
