import { useEffect, useRef, useState } from "react";
import { Archive, ArrowLeft, Crosshair, Loader2, MapPin } from "lucide-react";
import {
  WEB_ANNOTATION_COMMANDS,
  WEB_ANNOTATION_LIMITS,
  type WebAnnotation,
  type WebAnnotationCapture,
  type WebAnnotationRequestOperation,
} from "@orkestrator/protocol/web-annotations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useWebAnnotationThread } from "@/hooks/useWebAnnotations";
import {
  describeWebAnnotationError,
  newWebAnnotationOperationId,
  webAnnotationCommand,
} from "@/lib/web-annotations/client";
import { refreshWebAnnotations } from "@/lib/web-annotations/sync";
import { AnnotationEntries } from "./AnnotationEntries";
import { AnnotationImage } from "./AnnotationImage";
import { ReplyEditor } from "./AnnotationReply";
import {
  anchorStateLabel,
  annotationStateLabel,
  annotationTitle,
  pageLabel,
  sameService,
  targetPrecision,
  viewportLabel,
} from "./format";
import { useAnnotationPanel, type ShowOnPageResult } from "./panel-context";
import { RequestCard } from "./RequestCard";
import { RequestComposer, type ComposerItem } from "./RequestComposer";
import { SavedImageControls } from "./SavedImageControls";
import { useThreadHistory } from "./useThreadHistory";

function CaptureEvidence({ capture }: { capture: WebAnnotationCapture }) {
  const [open, setOpen] = useState(false);
  const evidence = capture.evidence;
  if (!evidence && capture.target.kind !== "legacy-unresolved") return null;
  return (
    <details
      className="text-[11px]"
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer text-muted-foreground">Page evidence (untrusted)</summary>
      {open && (
        <div className="mt-1 space-y-1 break-words">
          {capture.target.kind === "legacy-unresolved" && (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[10px]">
              {capture.target.referenceText}
            </pre>
          )}
          {evidence?.text && <p>Text: “{evidence.text}”</p>}
          {evidence && Object.keys(evidence.attributes).length > 0 && (
            <p className="font-mono text-[10px]">
              Attributes: {JSON.stringify(evidence.attributes)}
            </p>
          )}
          {evidence && Object.keys(evidence.styles).length > 0 && (
            <p className="font-mono text-[10px]">Styles: {JSON.stringify(evidence.styles)}</p>
          )}
          {evidence?.html && (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[10px]">
              {evidence.html}
            </pre>
          )}
          {capture.redaction.imageExcluded && <p>The image was excluded when this was saved.</p>}
        </div>
      )}
    </details>
  );
}

export function showOnPageMessage(result: ShowOnPageResult): string | null {
  switch (result.status) {
    case "shown":
      return null;
    case "off-page":
      return `This note is on ${result.route}.`;
    case "not-found":
      return `Could not find this target on the page (${result.reason}). Reselect it to attach current evidence.`;
    case "navigation-required":
      return `${result.reason} Navigate to the page yourself, then reselect the target.`;
    case "timeout":
      return "The page did not finish loading in time. Try again, or open it yourself.";
    case "navigation-failed":
      return `${result.reason} Check that the app is running, then try again.`;
    case "unavailable":
      return result.reason;
  }
}

function ArchivedBanner({ annotation }: { annotation: WebAnnotation }) {
  const { selectAnnotation } = useAnnotationPanel();
  if (!annotation.archivedAt && !annotation.continuedFromId) return null;
  return (
    <div
      className="space-y-1 rounded border border-border/60 bg-muted/20 p-1.5 text-[11px]"
      data-archived={annotation.archivedAt ? "true" : "false"}
    >
      {annotation.archivedAt && (
        <p className="flex items-center gap-1">
          <Archive className="h-3 w-3" aria-hidden />
          Archived {new Date(annotation.archivedAt).toLocaleString()}: read-only history.
        </p>
      )}
      <div className="flex flex-wrap gap-1.5">
        {annotation.continuationId && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[11px]"
            onClick={() => selectAnnotation(annotation.continuationId!)}
          >
            Open the continued note
          </Button>
        )}
        {annotation.continuedFromId && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            onClick={() => selectAnnotation(annotation.continuedFromId!)}
          >
            Open the archived earlier discussion
          </Button>
        )}
      </div>
    </div>
  );
}

export function AnnotationThread({
  annotationId,
  onBack,
}: {
  annotationId: string;
  onBack: () => void;
}) {
  const panel = useAnnotationPanel();
  const { environmentId, features, capture, announce } = panel;
  const thread = useWebAnnotationThread(environmentId, annotationId);
  const data = thread?.data ?? null;
  const annotation = data?.annotation ?? null;
  const history = useThreadHistory(environmentId, data);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const replyRef = useRef<HTMLTextAreaElement | null>(null);
  const [composer, setComposer] = useState<{
    operation: WebAnnotationRequestOperation | null;
    /** Follow-up items (other threads' notes included); default is this note. */
    items?: ComposerItem[];
    reference?: { retargetOf?: string; followUpOf?: string; previousTabId?: string };
  } | null>(null);
  const [editingTitle, setEditingTitle] = useState<string | null>(null);
  const [locate, setLocate] = useState<ShowOnPageResult | null>(null);
  const [locating, setLocating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [seenSequence, setSeenSequence] = useState<number | null>(null);

  // Focus flow: opening a thread moves focus to its heading once it renders
  // (the first snapshot may still be loading when the thread opens).
  const loaded = Boolean(annotation);
  useEffect(() => {
    if (loaded) headingRef.current?.focus();
  }, [annotationId, loaded]);
  useEffect(() => {
    // Everything present when the thread opens counts as read.
    if (annotation && seenSequence === null) setSeenSequence(annotation.lastSequence);
  }, [annotation, seenSequence]);

  const mutate = async (label: string, action: () => Promise<unknown>): Promise<boolean> => {
    setMessage(null);
    try {
      await action();
      refreshWebAnnotations(environmentId, { annotationIds: [annotationId] });
      announce(label);
      return true;
    } catch (error) {
      const text = describeWebAnnotationError(error);
      setMessage(text);
      announce(text);
      return false;
    }
  };

  const locateTarget = async (navigate: boolean) => {
    if (!annotation) return;
    setLocating(true);
    try {
      const result = await panel.showOnPage(annotation, { navigate });
      setLocate(result);
      const text = showOnPageMessage(result);
      if (text) announce(text);
      else if (result.status === "shown") announce("Shown on the page");
    } finally {
      setLocating(false);
    }
  };

  if (!thread || (thread.status === "loading" && !data)) {
    return (
      <div className="flex items-center gap-1.5 p-3 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden /> Loading note…
      </div>
    );
  }
  if (!data || !annotation) {
    return (
      <div className="space-y-2 p-3 text-xs">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 gap-1 px-2 text-xs"
          onClick={onBack}
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> All notes
        </Button>
        <p role="alert" className="text-muted-foreground">
          {thread.status === "missing"
            ? "This note no longer exists."
            : `This note could not be loaded: ${thread.error ?? "unknown error"}.`}
        </p>
      </div>
    );
  }

  const archived = Boolean(annotation.archivedAt);
  const captureRecord = data.capture;
  const requests = [...data.requests].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const newest = Math.max(
    annotation.lastSequence,
    ...history.entries.map((entry) => entry.sequence),
  );
  const unread = seenSequence !== null && newest > seenSequence;
  const pin = panel.pinResults.get(annotation.id);
  const viewport = viewportLabel(captureRecord?.geometry?.viewport);
  // Another route on the same server can be opened and resolved in one step.
  const openPage = () => {
    setLocate(null);
    void locateTarget(true).then(() => undefined);
  };

  return (
    <div
      className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          if (composer) {
            event.stopPropagation();
            setComposer(null);
          }
        }
      }}
    >
      <div className="space-y-1">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="-ml-2 h-6 gap-1 px-2 text-[11px]"
          onClick={onBack}
        >
          <ArrowLeft className="h-3 w-3" aria-hidden /> All notes
        </Button>
        {editingTitle !== null ? (
          <form
            className="flex gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              const title = editingTitle.trim();
              if (!title) return;
              void mutate("Title updated", () =>
                webAnnotationCommand(WEB_ANNOTATION_COMMANDS.update, {
                  environmentId,
                  operationId: newWebAnnotationOperationId("title"),
                  annotationId,
                  expectedMetadataRevision: annotation.metadataRevision,
                  title,
                }),
              ).then((ok) => {
                if (ok) setEditingTitle(null);
              });
            }}
          >
            <Input
              value={editingTitle}
              onChange={(event) =>
                setEditingTitle(event.target.value.slice(0, WEB_ANNOTATION_LIMITS.titleChars))
              }
              aria-label="Note title"
              className="h-7 text-xs"
              autoFocus
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  setEditingTitle(null);
                }
              }}
            />
            <Button type="submit" size="sm" className="h-7 px-2 text-xs">
              Save
            </Button>
          </form>
        ) : (
          <h3
            ref={headingRef}
            tabIndex={-1}
            className="break-words text-sm font-semibold text-foreground outline-none"
          >
            {annotationTitle(annotation)}
          </h3>
        )}
        <p className="break-words text-[11px] text-muted-foreground">
          {annotationStateLabel(annotation)} · {annotation.targetLabel} ·{" "}
          {pageLabel(annotation.page)}
          {viewport ? ` · ${viewport}` : ""}
        </p>
        <p className="text-[11px] text-muted-foreground">
          {targetPrecision(annotation.targetKind)}
        </p>
        {pin && (pin.state !== "matched" || pin.historical) && (
          <p className="text-[11px] text-amber-200" data-pin-state={pin.state}>
            {anchorStateLabel(pin)}
          </p>
        )}
        {annotation.unavailable && (
          <p className="text-[11px] text-amber-200">{annotation.unavailable}</p>
        )}
        <ArchivedBanner annotation={annotation} />
        <div className="flex flex-wrap gap-1">
          {features.author && !archived && editingTitle === null && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              onClick={() => setEditingTitle(annotation.title)}
            >
              Edit title
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 gap-1 px-2 text-[11px]"
            disabled={locating}
            aria-label={`Show “${annotationTitle(annotation)}” on the page`}
            onClick={() => void locateTarget(false)}
          >
            {locating ? (
              <Loader2 className="h-3 w-3 motion-safe:animate-spin" aria-hidden />
            ) : (
              <MapPin className="h-3 w-3" aria-hidden />
            )}
            Show on page
          </Button>
          {features.capture && annotation.state === "open" && !archived && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 gap-1 px-2 text-[11px]"
              disabled={capture.selecting}
              onClick={() =>
                void capture.start(panel.captureMode, {
                  annotationId,
                  intent: { kind: "reselect", annotationId, createdAt: Date.now() },
                })
              }
            >
              <Crosshair className="h-3 w-3" aria-hidden /> Reselect target
            </Button>
          )}
        </div>
        {locate && locate.status !== "shown" && (
          <div
            className="space-y-1 rounded border border-border/60 p-1.5 text-[11px]"
            data-locate={locate.status}
          >
            <p>{showOnPageMessage(locate)}</p>
            {locate.status === "off-page" && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-6 px-2 text-[11px]"
                onClick={() => {
                  // Same server: navigate, wait, resolve, and scroll in one step.
                  if (locateCanNavigate(panel, annotation)) {
                    openPage();
                    return;
                  }
                  const outcome = panel.navigateToPage(annotation.page);
                  setLocate(null);
                  if (!outcome.ok && outcome.message) setMessage(outcome.message);
                }}
              >
                Open that page
              </Button>
            )}
          </div>
        )}
      </div>

      <section aria-label="Captured target" className="space-y-1">
        {captureRecord ? (
          <>
            {captureRecord.state === "stale" && (
              <p className="text-[11px] text-amber-200">
                Stale capture{captureRecord.stateReason ? `: ${captureRecord.stateReason}` : ""}.
                The page may have changed since this was captured.
              </p>
            )}
            {captureRecord.state === "missing" && (
              <p className="text-[11px] text-amber-200">
                The captured evidence is missing
                {captureRecord.stateReason ? `: ${captureRecord.stateReason}` : ""}.
              </p>
            )}
            <AnnotationImage
              environmentId={environmentId}
              assetId={captureRecord.assetIds[0] ?? annotation.thumbnailAssetId}
              alt={`Capture of ${annotation.targetLabel}`}
            />
            {captureRecord.assetIds[1] && captureRecord.target.kind === "region" && (
              <AnnotationImage
                environmentId={environmentId}
                assetId={captureRecord.assetIds[1]}
                alt={`Selected region of ${annotation.targetLabel}`}
                className="max-h-32"
              />
            )}
            <SavedImageControls annotation={annotation} capture={captureRecord} />
            <CaptureEvidence capture={captureRecord} />
          </>
        ) : (
          <p className="text-[11px] text-amber-200">The capture record is unavailable.</p>
        )}
      </section>

      <section aria-label="Thread" className="space-y-1.5">
        {history.hasOlder && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            disabled={history.loading}
            onClick={() => void history.loadOlder()}
          >
            {history.loading && (
              <Loader2 className="mr-1 h-3 w-3 motion-safe:animate-spin" aria-hidden />
            )}
            Show older entries
          </Button>
        )}
        {unread && (
          <button
            type="button"
            className="text-[11px] text-primary underline-offset-2 hover:underline"
            onClick={() => setSeenSequence(newest)}
          >
            New activity — mark as read
          </button>
        )}
        <AnnotationEntries
          annotation={annotation}
          entries={history.entries}
          seenSequence={seenSequence ?? newest}
          canEdit={features.author && !archived}
        />
        {history.hasNewer && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            disabled={history.loading}
            onClick={() => void history.loadNewer()}
          >
            Show later entries
          </Button>
        )}
        {history.error && (
          <p role="alert" className="text-[11px] text-destructive">
            {history.error}
          </p>
        )}
      </section>

      {requests.length > 0 && (
        <section aria-label="Agent requests" className="space-y-1.5">
          {requests.map((request) => (
            <RequestCard
              key={request.id}
              request={request}
              annotation={annotation}
              results={data.results.filter((result) => result.requestId === request.id)}
              onReply={() => replyRef.current?.focus()}
              onRequestAnother={(operation) => setComposer({ operation })}
              onRetarget={(target) =>
                setComposer({
                  operation: target.operation,
                  reference: {
                    retargetOf: target.id,
                    previousTabId: target.destination.tabId,
                  },
                })
              }
              onFollowUp={(items, followUpOf) =>
                setComposer({ operation: request.operation, items, reference: { followUpOf } })
              }
            />
          ))}
        </section>
      )}

      {annotation.state === "resolved" && (
        <section
          aria-label="Resolution"
          className="space-y-1 rounded border border-emerald-500/30 bg-emerald-500/5 p-2 text-[11px]"
        >
          <p>
            Resolved{" "}
            {annotation.resolution
              ? `on ${new Date(annotation.resolution.acceptedAt).toLocaleString()}`
              : ""}
            {annotation.resolution?.requestId ? " after reviewing a request" : ""}.
          </p>
          {features.resolve && !archived && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              onClick={() =>
                void mutate("Reopened", () =>
                  webAnnotationCommand(WEB_ANNOTATION_COMMANDS.reopen, {
                    environmentId,
                    operationId: newWebAnnotationOperationId("reopen"),
                    annotationId,
                    expectedMetadataRevision: annotation.metadataRevision,
                  }),
                )
              }
            >
              Reopen
            </Button>
          )}
        </section>
      )}

      {!archived && <ReplyEditor annotation={annotation} inputRef={replyRef} />}

      {composer && !archived ? (
        <RequestComposer
          key={composer.reference?.retargetOf ?? composer.reference?.followUpOf ?? "note"}
          items={composer.items ?? [{ annotation }]}
          reference={composer.reference ?? null}
          initialOperation={composer.operation}
          onClose={() => setComposer(null)}
          onSent={() => setComposer(null)}
        />
      ) : (
        features.dispatch &&
        annotation.state === "open" &&
        !archived && (
          <div className="space-y-1">
            {requests.length === 0 && (
              <p className="text-[11px] text-muted-foreground">
                Choose an agent to discuss or request changes.
              </p>
            )}
            <div className="flex flex-wrap gap-1.5">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                onClick={() => setComposer({ operation: "discuss" })}
              >
                Discuss…
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                onClick={() => setComposer({ operation: "implement" })}
              >
                Request changes…
              </Button>
            </div>
          </div>
        )
      )}

      {features.author && !archived && (
        <div className="border-t border-border/60 pt-2">
          {confirmDelete ? (
            <div role="alert" className="space-y-1 text-[11px]">
              <p>Delete this note and its discussion? Requests already sent are not undone.</p>
              <div className="flex gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  className="h-6 px-2 text-[11px]"
                  onClick={() =>
                    void mutate("Note deleted", () =>
                      webAnnotationCommand(WEB_ANNOTATION_COMMANDS.delete, {
                        environmentId,
                        operationId: newWebAnnotationOperationId("delete"),
                        annotationId,
                        expectedMetadataRevision: annotation.metadataRevision,
                      }),
                    ).then((ok) => {
                      setConfirmDelete(false);
                      if (ok) onBack();
                    })
                  }
                >
                  Delete note
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => setConfirmDelete(false)}
                >
                  Keep
                </Button>
              </div>
            </div>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px] text-muted-foreground"
              onClick={() => setConfirmDelete(true)}
            >
              Delete note…
            </Button>
          )}
        </div>
      )}
      {message && (
        <p role="alert" className="text-[11px] text-destructive">
          {message}
        </p>
      )}
    </div>
  );
}

/** Desktop contract 2 can open another route of the current server itself. */
function locateCanNavigate(
  panel: ReturnType<typeof useAnnotationPanel>,
  annotation: WebAnnotation,
): boolean {
  return (
    Boolean(panel.capture.desktopCapabilities?.features.showOnPage) &&
    sameService(annotation.page, panel.currentPage)
  );
}
