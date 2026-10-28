import { useRef, useState } from "react";
import type { BuildPipelineCodeRewindPreview } from "@orkestrator/protocol/build-pipeline";
import * as backend from "@/lib/backend";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface CodeRewindRequest {
  stageId: string;
  title: string;
  preview?: BuildPipelineCodeRewindPreview;
  error?: string;
}

function shortSha(sha: string | undefined): string {
  return sha ? sha.slice(0, 7) : "an unknown commit";
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/**
 * "Rewind code to here": opens a confirmation that names the commits a reset
 * to the step's starting commit drops, read from the backend when it opens.
 * The confirmed request carries the HEAD the preview showed, so a branch that
 * moved in between is refused rather than reset blind.
 */
export function usePipelineCodeRewind(
  pipelineId: string,
  rewind: (stageId: string, expectedHead: string) => Promise<boolean>,
  pending: boolean,
) {
  const [request, setRequest] = useState<CodeRewindRequest | null>(null);
  // Answers for a request the user has since closed or replaced are dropped.
  const generation = useRef(0);

  const open = (stageId: string, title: string) => {
    const current = ++generation.current;
    setRequest({ stageId, title });
    backend.previewBuildPipelineCodeRewind(pipelineId, stageId).then(
      (preview) => {
        if (generation.current === current) {
          setRequest((previous) => (previous ? { ...previous, preview } : previous));
        }
      },
      (error: unknown) => {
        if (generation.current === current) {
          const message = error instanceof Error ? error.message : String(error);
          setRequest((previous) => (previous ? { ...previous, error: message } : previous));
        }
      },
    );
  };

  const close = () => {
    generation.current += 1;
    setRequest(null);
  };

  const preview = request?.preview;
  const canConfirm = Boolean(preview && !preview.blocked && preview.head && !pending);
  const confirm = async () => {
    if (!request || !preview?.head || !canConfirm) return;
    if (await rewind(request.stageId, preview.head)) close();
  };

  const dialog = (
    <AlertDialog open={request !== null} onOpenChange={(next) => (next ? undefined : close())}>
      <AlertDialogContent data-testid="pipeline-code-rewind-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Rewind code to {request?.title}?</AlertDialogTitle>
          <AlertDialogDescription>
            Resets the branch to {shortSha(preview?.targetCommit)}, the commit this step started
            from, and restarts the pipeline from this step. The steps after it become a previous
            attempt.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex min-w-0 flex-col gap-3 text-sm">
          {request?.error ? (
            <p role="alert" className="text-destructive">
              {request.error}
            </p>
          ) : !preview ? (
            <p className="text-muted-foreground">Reading the branch…</p>
          ) : (
            <CodeRewindDetails preview={preview} />
          )}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={!canConfirm}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={(event) => {
              // Stays open until the backend answers; a refusal is shown by toast.
              event.preventDefault();
              void confirm();
            }}
          >
            {preview && preview.commitCount > 0
              ? `Drop ${plural(preview.commitCount, "commit")} and restart`
              : "Rewind and restart"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { open, dialog };
}

function CodeRewindDetails({ preview }: { preview: BuildPipelineCodeRewindPreview }) {
  const more = preview.commitCount - preview.commits.length;
  const pushed = preview.upstream?.droppedCommits ?? 0;
  return (
    <>
      {preview.blocked ? (
        <p role="alert" className="text-destructive">
          {preview.blocked}
        </p>
      ) : null}
      {preview.uncommittedPaths?.length ? (
        <ul className="ml-4 list-disc font-mono text-xs text-muted-foreground">
          {preview.uncommittedPaths.map((path) => (
            <li key={path} className="truncate">
              {path}
            </li>
          ))}
        </ul>
      ) : null}
      {preview.head ? (
        preview.commitCount === 0 ? (
          <p className="text-muted-foreground">
            No commits are dropped: the branch is still there.
          </p>
        ) : (
          <div className="flex min-w-0 flex-col gap-1">
            <p>Drops {plural(preview.commitCount, "commit")} from the branch:</p>
            <ul data-testid="pipeline-code-rewind-commits" className="flex flex-col gap-0.5">
              {preview.commits.map((commit) => (
                <li key={commit.sha} className="flex min-w-0 gap-2 text-xs">
                  <span className="shrink-0 font-mono text-muted-foreground">
                    {shortSha(commit.sha)}
                  </span>
                  <span className="truncate" title={commit.subject}>
                    {commit.subject}
                  </span>
                </li>
              ))}
              {more > 0 ? (
                <li className="text-xs text-muted-foreground">and {plural(more, "more commit")}</li>
              ) : null}
            </ul>
          </div>
        )
      ) : null}
      {pushed > 0 ? (
        <p className="text-amber-300">
          {preview.upstream!.ref} already has {plural(pushed, "commit")} that the rewind drops
          {preview.pullRequest ? ", and so does the pull request" : ""}. The next Ship force-pushes
          with lease to replace them.
        </p>
      ) : null}
      {preview.pullRequest?.state === "closed" ? (
        <p className="text-muted-foreground">The next Ship reopens the closed pull request.</p>
      ) : null}
      {preview.commitCount > 0 ? (
        <p className="text-xs text-muted-foreground">
          The current tip, {shortSha(preview.head)}, stays reachable under refs/orkestrator/, so the
          dropped commits can be recovered.
        </p>
      ) : null}
    </>
  );
}
