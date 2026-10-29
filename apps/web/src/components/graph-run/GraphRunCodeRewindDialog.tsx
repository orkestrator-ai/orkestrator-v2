import { useRef, useState } from "react";
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
import type { GraphRunCodeRewindPreview, GraphRunRewindBackend } from "@/lib/backend/graph-runs";

interface Request {
  activationKey: string;
  title: string;
  preview?: GraphRunCodeRewindPreview;
  error?: string;
}

function shortSha(sha: string | undefined): string {
  return sha ? sha.slice(0, 7) : "an unknown commit";
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/**
 * "Rewind code to here" on a graph run (P2.10, item 210's backend): reads
 * the preview when it opens (the commits a reset to the node's input
 * `workspace@1` commit drops, and any refusal), and the confirmed request
 * carries the HEAD the preview showed, so a branch that moved in between is
 * refused rather than reset blind. The node and everything downstream of it
 * become a previous attempt.
 */
export function useGraphRunCodeRewind(
  runId: string,
  backend: Pick<GraphRunRewindBackend, "previewCodeRewind">,
  rewind: (activationKey: string, expectedHead: string) => Promise<boolean>,
  pending: boolean,
) {
  const [request, setRequest] = useState<Request | null>(null);
  // Answers for a request the user has since closed or replaced are dropped.
  const generation = useRef(0);

  const open = (activationKey: string, title: string) => {
    const current = ++generation.current;
    setRequest({ activationKey, title });
    backend.previewCodeRewind(runId, activationKey).then(
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
    if (await rewind(request.activationKey, preview.head)) close();
  };

  const more = preview ? preview.commitCount - preview.commits.length : 0;
  const pushed = preview?.upstream?.droppedCommits ?? 0;
  const dialog = (
    <AlertDialog open={request !== null} onOpenChange={(next) => (next ? undefined : close())}>
      <AlertDialogContent data-testid="graph-run-code-rewind-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Rewind code to {request?.title}?</AlertDialogTitle>
          <AlertDialogDescription>
            Resets the branch to {shortSha(preview?.targetCommit)}, the commit this node read, and
            restarts the run from this node. The node and everything that used its results become a
            previous attempt.
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
                    <ul
                      data-testid="graph-run-code-rewind-commits"
                      className="flex flex-col gap-0.5"
                    >
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
                        <li className="text-xs text-muted-foreground">
                          and {plural(more, "more commit")}
                        </li>
                      ) : null}
                    </ul>
                  </div>
                )
              ) : null}
              {pushed > 0 ? (
                <p className="text-amber-300">
                  {preview.upstream!.ref} already has {plural(pushed, "commit")} that the rewind
                  drops. The run's next push replaces them with a force-push with lease.
                </p>
              ) : null}
              {preview.commitCount > 0 ? (
                <p className="text-xs text-muted-foreground">
                  The current tip, {shortSha(preview.head)}, stays reachable under
                  refs/orkestrator/, so the dropped commits can be recovered.
                </p>
              ) : null}
            </>
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
