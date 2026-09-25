import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  isWebAnnotationRequestActive,
  WEB_ANNOTATION_BLOCKED_REASON_LABELS,
  WEB_ANNOTATION_COMMANDS,
  WEB_ANNOTATION_REQUEST_STATE_LABELS,
  type WebAnnotation,
  type WebAnnotationRequest,
  type WebAnnotationRequestOperation,
  type WebAnnotationResponseExcerpt,
  type WebAnnotationResult,
} from "@orkestrator/protocol/web-annotations";
import { Button } from "@/components/ui/button";
import {
  describeWebAnnotationError,
  isWebAnnotationConflict,
  newWebAnnotationOperationId,
  webAnnotationCommand,
} from "@/lib/web-annotations/client";
import { openConversationAtMessage } from "@/lib/web-annotations/conversation-navigation";
import { openConversationTab, openWebAnnotationRequest } from "@/lib/web-annotations/navigation";
import { refreshWebAnnotations } from "@/lib/web-annotations/sync";
import { cn } from "@/lib/utils";
import { useFilesPanelStore } from "@/stores/filesPanelStore";
import { destinationName } from "./DestinationPicker";
import { lastActivity } from "./format";
import { useAnnotationPanel } from "./panel-context";
import type { ComposerItem } from "./RequestComposer";
import { RequestFollowUp } from "./RequestFollowUp";
import { pendingRequestInteractions, RequestInteractions } from "./RequestInteractions";
import {
  cancelRefusalText,
  destinationMissing,
  dispatchModeLabel,
  requestOutcomeNotes,
  stopFailed,
} from "./request-labels";
import { ResultReview } from "./ResultReview";

const RUNNING_STATES = new Set(["dispatching", "running", "needs-input", "cancelling"]);
const FOLLOW_UP_STATES = new Set(["completed", "awaiting-review", "failed"]);

/** Jump to a linked request: its card when it is in this thread, else its thread. */
function RequestLink({
  environmentId,
  requestId,
  label,
}: {
  environmentId: string;
  requestId: string;
  label: string;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <button
        type="button"
        className="text-primary underline-offset-2 hover:underline"
        data-request-link={requestId}
        onClick={() => {
          const card = Array.from(document.querySelectorAll<HTMLElement>("[data-request]")).find(
            (element) => element.dataset.request === requestId,
          );
          if (card) {
            card.scrollIntoView?.({ block: "nearest" });
            card.focus();
            return;
          }
          void openWebAnnotationRequest(environmentId, requestId).then((outcome) => {
            if (!outcome.ok) setError(outcome.error);
          });
        }}
      >
        {label}
      </button>
      {error && <span className="text-muted-foreground">({error})</span>}
    </span>
  );
}

function latestResult(results: WebAnnotationResult[]): WebAnnotationResult | null {
  const superseded = new Set(results.map((result) => result.supersedes).filter(Boolean));
  const current = results.filter((result) => !superseded.has(result.id));
  return current.sort((a, b) => b.revision - a.revision)[0] ?? null;
}

/**
 * One request's lifecycle and actions. Closing the panel never stops work;
 * Stop is an explicit, separate action. Delivery uncertainty stays visible
 * until the user retries with the same id or discards it knowingly.
 */
export function RequestCard({
  request,
  annotation,
  results,
  onReply,
  onRequestAnother,
  onRetarget,
  onFollowUp,
}: {
  request: WebAnnotationRequest;
  annotation: WebAnnotation;
  results: WebAnnotationResult[];
  onReply: () => void;
  onRequestAnother: (operation: WebAnnotationRequestOperation) => void;
  /** Send this never-run request's selections to another session (`retargetOf`). */
  onRetarget: (request: WebAnnotationRequest) => void;
  /** Prepare a follow-up request (`followUpOf`) for the chosen remaining notes. */
  onFollowUp: (items: ComposerItem[], followUpOf: string) => void;
}) {
  const { environmentId, announce, navigateToPage, features } = useAnnotationPanel();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [response, setResponse] = useState<{
    excerpt: WebAnnotationResponseExcerpt | null;
    sourceAvailable: boolean;
  } | null>(null);
  const [staleAccept, setStaleAccept] = useState<string | null>(null);
  const [showHistorical, setShowHistorical] = useState(false);
  const [followUpOpen, setFollowUpOpen] = useState(false);
  const resolveOperationRef = useRef<string | null>(null);
  const selection = request.selections.find((item) => item.annotationId === annotation.id);
  const active = isWebAnnotationRequestActive(request.state);
  const terminal = !active;
  const result = latestResult(results);
  const locallyStale =
    Boolean(selection) &&
    (annotation.contentRevision !== selection!.contentRevision ||
      annotation.currentCaptureId !== selection!.captureId);

  // The response excerpt is fetched only for settled requests.
  useEffect(() => {
    if (!terminal || request.state === "cancelled" || request.state === "abandoned-unconfirmed")
      return;
    let cancelled = false;
    void webAnnotationCommand(WEB_ANNOTATION_COMMANDS.requestResponse, {
      environmentId,
      requestId: request.id,
    })
      .then((value) => {
        if (!cancelled)
          setResponse({ excerpt: value.response, sourceAvailable: value.sourceAvailable });
      })
      .catch(() => {
        if (!cancelled) setResponse({ excerpt: request.response, sourceAvailable: false });
      });
    return () => {
      cancelled = true;
    };
  }, [environmentId, request.id, request.response, request.state, terminal]);

  const run = async (key: string, action: () => Promise<string | null>) => {
    setBusy(key);
    setMessage(null);
    try {
      const outcome = await action();
      if (outcome) {
        setMessage(outcome);
        announce(outcome);
      }
      refreshWebAnnotations(environmentId, {
        annotationIds: [annotation.id],
        requestIds: [request.id],
      });
    } catch (error) {
      const text = describeWebAnnotationError(error);
      setMessage(text);
      announce(text);
    } finally {
      setBusy(null);
    }
  };

  const openChat = () => {
    if (!openConversationTab(environmentId, request.destination.tabId)) {
      setMessage(
        "That chat tab is not open in this layout. The request continues in the background.",
      );
    }
  };

  /** Scroll the chat to this request's own turn when the transcript names it. */
  const openConversation = (messageId?: string) => {
    const target = {
      ...((messageId ?? request.transcript.messageId)
        ? { messageId: messageId ?? request.transcript.messageId }
        : {}),
      ...(request.transcript.turnId ? { turnId: request.transcript.turnId } : {}),
    };
    if (!openConversationAtMessage(environmentId, request.destination.tabId, target)) {
      setMessage(
        "That chat tab is not open in this layout. The request continues in the background.",
      );
    }
  };

  const stop = (queued = false) =>
    run(queued ? "cancel" : "stop", async () => {
      const result = await webAnnotationCommand(WEB_ANNOTATION_COMMANDS.requestCancel, {
        environmentId,
        requestId: request.id,
        expectedRevision: request.revision,
      });
      if (result.outcome === "cancelled")
        return queued ? "Request cancelled. It was never sent." : "Request stopped.";
      if (result.outcome === "cancelling")
        return "Stopping. The current turn may still finish before it stops.";
      return cancelRefusalText(result.refusal ?? result.request.cancelRefusal?.code);
    });

  const recover = (action: "retry" | "reconcile" | "discard") =>
    run(action, async () => {
      await webAnnotationCommand(WEB_ANNOTATION_COMMANDS.requestRecover, {
        environmentId,
        requestId: request.id,
        action,
      });
      setConfirmDiscard(false);
      if (action === "retry") return "Retrying delivery with the same request.";
      if (action === "discard")
        return "Discarded. The agent may still have run this request; check the chat.";
      return "Checked delivery status.";
    });

  const accept = () => {
    if (!selection) return;
    resolveOperationRef.current ??= newWebAnnotationOperationId("resolve");
    void run("accept", async () => {
      try {
        await webAnnotationCommand(WEB_ANNOTATION_COMMANDS.resolve, {
          environmentId,
          operationId: resolveOperationRef.current!,
          annotationId: annotation.id,
          expectedContentRevision: selection.contentRevision,
          expectedCaptureId: selection.captureId,
          requestId: request.id,
          ...(result ? { resultId: result.id, expectedResultRevision: result.revision } : {}),
        });
        resolveOperationRef.current = null;
        setStaleAccept(null);
        return "Accepted and resolved.";
      } catch (error) {
        // A transport failure keeps the operation id so a retry is idempotent.
        if (isWebAnnotationConflict(error)) {
          resolveOperationRef.current = null;
          setStaleAccept(
            "Newer notes or a new capture were added after this request was sent. Accepting this result would hide those newer requirements, so the note was not resolved.",
          );
          return null;
        }
        throw error;
      }
    });
  };

  const failedStop = active && stopFailed(request);
  const stateLabel = failedStop
    ? "Stop failed — may still be running"
    : request.state === "queued" && request.blockedReason
      ? WEB_ANNOTATION_BLOCKED_REASON_LABELS[request.blockedReason]
      : WEB_ANNOTATION_REQUEST_STATE_LABELS[request.state];
  const missingDestination = active && destinationMissing(request);
  const rejected = request.state === "queued" && request.blockedReason === "dispatch-rejected";
  const notes = requestOutcomeNotes(request);
  const pendingInteractions = pendingRequestInteractions(request).length;
  const modeLabel = dispatchModeLabel(request.dispatchMode);
  const canFollowUp =
    features.dispatch && FOLLOW_UP_STATES.has(request.state) && request.selections.length > 1;
  const reviewable =
    request.state === "awaiting-review" ||
    (request.state === "completed" && request.operation === "implement");
  const excerpt = response?.excerpt ?? request.response;

  return (
    <article
      aria-label={`${request.operation === "discuss" ? "Discussion" : "Change request"} with ${destinationName(request.destination)}`}
      className="space-y-1.5 rounded-md border border-border/70 bg-muted/10 p-2 text-[11px]"
      data-request={request.id}
      data-request-state={request.state}
      tabIndex={-1}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">
          {request.operation === "discuss" ? "Discuss" : "Request changes"} ·{" "}
          {destinationName(request.destination)}
        </span>
        <span
          className={cn(
            "shrink-0 rounded px-1.5 py-0.5",
            (request.state === "failed" || failedStop) && "bg-destructive/15 text-destructive",
            request.state === "unconfirmed" && "bg-amber-500/15 text-amber-200",
            reviewable && "bg-primary/15 text-foreground",
          )}
        >
          {stateLabel}
        </span>
      </div>
      <p className="text-muted-foreground">
        Sent {lastActivity(request.createdAt)}
        {modeLabel ? ` · ${modeLabel}` : ""}
        {request.selections.length > 1
          ? ` · ${request.selections.length} notes in this request (stopping affects all of them)`
          : ""}
      </p>
      {(request.followUpOf || request.retargetOf || request.retargetedTo) && (
        <p className="flex flex-wrap gap-x-2 text-muted-foreground" data-request-links>
          {request.followUpOf && (
            <RequestLink
              environmentId={environmentId}
              requestId={request.followUpOf}
              label="Follows up an earlier request"
            />
          )}
          {request.retargetOf && (
            <RequestLink
              environmentId={environmentId}
              requestId={request.retargetOf}
              label="Replaces a request to another session"
            />
          )}
          {request.retargetedTo && (
            <RequestLink
              environmentId={environmentId}
              requestId={request.retargetedTo}
              label="Moved to another session — open the new request"
            />
          )}
        </p>
      )}
      {request.stateReason && <p className="text-muted-foreground">{request.stateReason}</p>}
      {notes.map((note) => (
        <p
          key={note.key}
          data-request-note={note.key}
          className={cn(
            note.tone === "error" && "text-destructive",
            note.tone === "warning" && "text-amber-200",
            note.tone === "muted" && "text-muted-foreground",
          )}
        >
          {note.text}
        </p>
      ))}
      {locallyStale && (
        <p className="text-amber-200">
          This request used an older version of the note; newer notes or evidence are not part of
          it.
        </p>
      )}

      {missingDestination && (
        <div
          role="alert"
          className="space-y-1 rounded border border-amber-500/40 bg-amber-500/10 p-1.5"
        >
          <p>
            The agent session this was sent to no longer exists. It never ran; send it to another
            session or cancel it.
          </p>
          <div className="flex flex-wrap gap-1.5">
            <Button
              type="button"
              size="sm"
              className="h-6 px-2 text-[11px]"
              disabled={busy !== null || !features.dispatch}
              onClick={() => onRetarget(request)}
            >
              Send to another session…
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              disabled={busy !== null || !features.recover}
              onClick={() => void stop(true)}
            >
              Cancel request
            </Button>
          </div>
        </div>
      )}

      {rejected && !missingDestination && (
        <div
          role="alert"
          className="space-y-1 rounded border border-destructive/40 bg-destructive/10 p-1.5"
        >
          <p>
            The agent rejected this request, and the chat queue is waiting on it. Retry sends the
            same request again; nothing runs twice.
          </p>
          <div className="flex flex-wrap gap-1.5">
            <Button
              type="button"
              size="sm"
              className="h-6 px-2 text-[11px]"
              disabled={busy !== null || !features.recover}
              onClick={() => void recover("retry")}
            >
              Retry
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              disabled={busy !== null || !features.recover}
              onClick={() => void stop(true)}
            >
              Cancel request
            </Button>
          </div>
        </div>
      )}

      {request.state === "queued" && !missingDestination && (
        <div className="flex flex-wrap gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[11px]"
            onClick={openChat}
          >
            Open chat
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            disabled={busy !== null || !features.dispatch}
            onClick={() => onRetarget(request)}
          >
            Choose another session
          </Button>
          {!rejected && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              disabled={busy !== null || !features.recover}
              onClick={() => void stop(true)}
            >
              Cancel request
            </Button>
          )}
        </div>
      )}

      {request.state === "unconfirmed" && (
        <div className="space-y-1">
          <p>Orkestrator could not confirm whether this was delivered.</p>
          <div className="flex flex-wrap gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              disabled={busy !== null || !features.recover}
              onClick={() => void recover("retry")}
            >
              Retry delivery
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              disabled={busy !== null || !features.recover}
              onClick={() => void recover("reconcile")}
            >
              Check again
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              disabled={busy !== null || !features.recover}
              onClick={() => setConfirmDiscard(true)}
            >
              Discard
            </Button>
          </div>
          {confirmDiscard && (
            <div
              role="alert"
              className="space-y-1 rounded border border-amber-500/40 bg-amber-500/10 p-1.5"
            >
              <p>
                The agent may already have run this request. Discarding does not undo that work.
              </p>
              <div className="flex gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => void recover("discard")}
                >
                  Discard anyway
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => setConfirmDiscard(false)}
                >
                  Keep
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {request.state === "needs-input" && pendingInteractions > 0 && (
        <RequestInteractions request={request} onAnswerInChat={() => openConversation()} />
      )}

      {RUNNING_STATES.has(request.state) && (
        <div className="flex flex-wrap gap-1.5">
          {request.state === "needs-input" && pendingInteractions === 0 && (
            <Button
              type="button"
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={() => openConversation()}
            >
              Answer in chat
            </Button>
          )}
          {request.state !== "needs-input" && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              onClick={openChat}
            >
              Open chat
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px] text-destructive"
            disabled={busy !== null || !features.recover || request.state === "cancelling"}
            onClick={() => void stop()}
          >
            {busy === "stop" && (
              <Loader2 className="mr-1 h-3 w-3 motion-safe:animate-spin" aria-hidden />
            )}
            {failedStop ? "Try stopping again" : "Stop"}
          </Button>
        </div>
      )}

      {excerpt && (
        <blockquote className="border-l-2 border-primary/40 pl-2" data-response-excerpt>
          <p className="whitespace-pre-wrap break-words">{excerpt.text}</p>
          {excerpt.truncated && <p className="text-muted-foreground">(excerpt)</p>}
        </blockquote>
      )}
      {terminal && (excerpt || response) && (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[11px]"
            onClick={() => openConversation(excerpt?.messageId)}
          >
            Open full conversation
          </Button>
          {response && !response.sourceAvailable && (
            <span className="text-muted-foreground">
              The original conversation is unavailable; this is a saved copy.
            </span>
          )}
        </div>
      )}

      {reviewable && (
        <div className="space-y-1.5 border-t border-border/60 pt-1.5">
          <ResultReview
            result={result}
            annotationId={annotation.id}
            originalCaptureId={selection?.captureId ?? null}
            requestId={request.id}
            historical={showHistorical}
          />
          <div className="flex flex-wrap gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              onClick={() => {
                const outcome = navigateToPage(annotation.page);
                if (!outcome.ok && outcome.message) setMessage(outcome.message);
              }}
            >
              Open updated page
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              title="Shows every change in this workspace, not only this request's"
              onClick={() => {
                const files = useFilesPanelStore.getState();
                files.setActiveTab("changes");
                files.openPanel();
              }}
            >
              Open changes (current workspace diff)
            </Button>
            {annotation.state === "open" && (
              <Button
                type="button"
                size="sm"
                className="h-6 px-2 text-[11px]"
                disabled={busy !== null || !features.resolve}
                onClick={accept}
              >
                Accept and resolve
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              onClick={onReply}
            >
              Reply / request another change
            </Button>
          </div>
          {staleAccept && (
            <div
              role="alert"
              className="space-y-1 rounded border border-amber-500/40 bg-amber-500/10 p-1.5"
            >
              <p>{staleAccept}</p>
              <div className="flex gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => setShowHistorical(true)}
                >
                  Review older result
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => onRequestAnother("implement")}
                >
                  Request another change
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {(request.state === "failed" || canFollowUp) && !followUpOpen && (
        <div className="flex flex-wrap gap-1.5">
          {request.state === "failed" && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              onClick={() => onRequestAnother(request.operation)}
            >
              Try again
            </Button>
          )}
          {canFollowUp && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              onClick={() => setFollowUpOpen(true)}
            >
              Send remaining work…
            </Button>
          )}
        </div>
      )}
      {followUpOpen && (
        <RequestFollowUp
          request={request}
          onClose={() => setFollowUpOpen(false)}
          onPrepare={(items, followUpOf) => {
            setFollowUpOpen(false);
            onFollowUp(items, followUpOf);
          }}
        />
      )}
      {message && <p className="text-muted-foreground">{message}</p>}
    </article>
  );
}
