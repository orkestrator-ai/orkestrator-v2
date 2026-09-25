import { useRef, useState, type RefObject } from "react";
import { Archive, Loader2 } from "lucide-react";
import {
  WEB_ANNOTATION_COMMANDS,
  WEB_ANNOTATION_LIMITS,
  type WebAnnotation,
  type WebAnnotationErrorDetail,
} from "@orkestrator/protocol/web-annotations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  describeWebAnnotationError,
  isTransientWebAnnotationError,
  newWebAnnotationOperationId,
  webAnnotationCommand,
  webAnnotationErrorDetail,
} from "@/lib/web-annotations/client";
import { refreshWebAnnotations } from "@/lib/web-annotations/sync";
import { draftStatusLabel, replyEditorId } from "./AnnotationEditor";
import { annotationTitle } from "./format";
import { useAnnotationPanel } from "./panel-context";
import { useAnnotationDraft } from "./useAnnotationDraft";

/** Share of a thread's entry/text limit at which the archive path is offered early. */
const NEAR_CAPACITY = 0.9;

export function threadNearCapacity(annotation: Pick<WebAnnotation, "entryCount" | "entryBytes">) {
  return (
    annotation.entryCount >= Math.floor(WEB_ANNOTATION_LIMITS.threadEntries * NEAR_CAPACITY) ||
    annotation.entryBytes >= Math.floor(WEB_ANNOTATION_LIMITS.threadTextBytes * NEAR_CAPACITY)
  );
}

/**
 * Archive a full thread and continue in a linked new one, in one backend
 * commit. The pending reply (if any) becomes the continuation's first note,
 * so nothing typed is dropped.
 */
export function ArchiveAndContinue({
  annotation,
  pendingText,
  onArchived,
  reason,
}: {
  annotation: WebAnnotation;
  pendingText: string;
  onArchived: (continuationId: string, usedText: boolean) => void;
  reason: string;
}) {
  const { environmentId, announce } = useAnnotationPanel();
  const [title, setTitle] = useState(`${annotationTitle(annotation)} (continued)`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operationRef = useRef<string | null>(null);
  const archive = async () => {
    setBusy(true);
    setError(null);
    // Stable across a retry after a lost response.
    operationRef.current ??= newWebAnnotationOperationId("archive");
    const body = pendingText.trim() ? pendingText : undefined;
    try {
      const result = await webAnnotationCommand(WEB_ANNOTATION_COMMANDS.archive, {
        environmentId,
        operationId: operationRef.current,
        annotationId: annotation.id,
        expectedMetadataRevision: annotation.metadataRevision,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(body ? { body } : {}),
      });
      operationRef.current = null;
      refreshWebAnnotations(environmentId, {
        annotationIds: [annotation.id, result.continuation.annotationId],
      });
      announce("Archived. The discussion continues in a new note.");
      onArchived(result.continuation.annotationId, Boolean(body));
    } catch (archiveError) {
      const { detail } = webAnnotationErrorDetail(archiveError);
      if (detail?.code === "conflict") operationRef.current = null;
      setError(describeWebAnnotationError(archiveError));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      role="group"
      aria-label="Archive and continue"
      className="space-y-1 rounded border border-amber-500/40 bg-amber-500/10 p-1.5 text-[11px]"
      data-archive-continue
    >
      <p>{reason}</p>
      <p className="text-muted-foreground">
        Archiving keeps this discussion readable as history and starts a linked note with the same
        target and evidence{pendingText.trim() ? ", starting with your unsent reply" : ""}.
      </p>
      <Input
        value={title}
        onChange={(event) =>
          setTitle(event.target.value.slice(0, WEB_ANNOTATION_LIMITS.titleChars))
        }
        aria-label="Title of the continued note"
        className="h-7 text-xs"
      />
      <Button
        type="button"
        size="sm"
        className="h-6 gap-1 px-2 text-[11px]"
        disabled={busy}
        onClick={() => void archive()}
      >
        {busy ? (
          <Loader2 className="h-3 w-3 motion-safe:animate-spin" aria-hidden />
        ) : (
          <Archive className="h-3 w-3" aria-hidden />
        )}
        Archive and continue
      </Button>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export function ReplyEditor({
  annotation,
  inputRef,
}: {
  annotation: WebAnnotation;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const { environmentId, features, announce, selectAnnotation } = useAnnotationPanel();
  const draft = useAnnotationDraft({
    environmentId,
    editorId: replyEditorId(annotation.id),
    context: { annotationId: annotation.id },
    enabled: features.drafts,
  });
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<WebAnnotationErrorDetail | null>(null);
  const [saving, setSaving] = useState(false);
  const operationRef = useRef<string | null>(null);
  const conflict = failure?.code === "conflict";

  const publish = async (target: { id: string; contentRevision: number } = annotation) => {
    const body = draft.readText();
    if (!body.trim()) {
      setError("Write a reply first.");
      return;
    }
    setSaving(true);
    setError(null);
    setFailure(null);
    operationRef.current ??= newWebAnnotationOperationId("reply");
    try {
      await draft.flush();
      await webAnnotationCommand(WEB_ANNOTATION_COMMANDS.entryAppend, {
        environmentId,
        operationId: operationRef.current,
        annotationId: target.id,
        expectedContentRevision: target.contentRevision,
        body,
        editorId: replyEditorId(annotation.id),
      });
      operationRef.current = null;
      // Only the published text is cleared; later keystrokes stay.
      void draft.clearSaved(body);
      refreshWebAnnotations(environmentId, { annotationIds: [target.id] });
      announce("Reply saved");
      if (target.id !== annotation.id) selectAnnotation(target.id);
    } catch (saveError) {
      // A lost response keeps the operation id, so retrying finds the
      // original receipt instead of appending the reply twice.
      if (!isTransientWebAnnotationError(saveError)) operationRef.current = null;
      const { detail } = webAnnotationErrorDetail(saveError);
      setFailure(detail);
      if (detail?.code === "conflict") {
        refreshWebAnnotations(environmentId, { annotationIds: [annotation.id] });
      } else {
        const message = describeWebAnnotationError(saveError);
        setError(message);
        announce(`Reply not saved: ${message}`);
      }
    } finally {
      setSaving(false);
    }
  };

  /** The thread was archived elsewhere: post this reply in its continuation. */
  const publishInContinuation = async (continuationId: string) => {
    try {
      const { annotation: continuation } = await webAnnotationCommand(WEB_ANNOTATION_COMMANDS.get, {
        environmentId,
        annotationId: continuationId,
        entryLimit: 1,
      });
      await publish({ id: continuation.id, contentRevision: continuation.contentRevision });
    } catch (loadError) {
      setError(describeWebAnnotationError(loadError));
    }
  };

  if (!features.drafts && !features.author) return null;
  const readOnly = !features.author;
  const capacityFull =
    failure?.code === "capacity" &&
    (failure.resource === "thread-entries" || failure.resource === "thread-bytes");
  const showArchive =
    features.archive && !annotation.archivedAt && (capacityFull || threadNearCapacity(annotation));
  return (
    <div className="space-y-1">
      <Textarea
        ref={inputRef}
        value={draft.text}
        onChange={(event) => draft.setText(event.target.value)}
        maxLength={WEB_ANNOTATION_LIMITS.entryChars}
        rows={3}
        aria-label={`Reply to ${annotationTitle(annotation)}`}
        placeholder="Add a note or reply. Saving does not send anything to an agent."
        className="text-xs"
      />
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{draftStatusLabel(draft.status, draft.localOnly)}</span>
        <Button
          type="button"
          size="sm"
          className="h-6 px-2 text-[11px]"
          disabled={saving || readOnly}
          onClick={() => void publish()}
        >
          {saving && <Loader2 className="mr-1 h-3 w-3 motion-safe:animate-spin" aria-hidden />}
          Save reply
        </Button>
      </div>
      {readOnly && (
        <p className="text-[11px] text-amber-200">
          Replies are paused in read-only recovery mode. Your text is kept as a draft.
        </p>
      )}
      {conflict && (
        <div
          role="alert"
          className="space-y-1 rounded border border-amber-500/40 bg-amber-500/10 p-1.5 text-[11px]"
        >
          <p>The note changed while you were writing. Your reply is kept.</p>
          <div className="flex gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              onClick={() => void publish()}
            >
              Keep as new reply
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              onClick={() => {
                // The thread was refreshed when the conflict was reported;
                // the reply text stays so nothing typed is lost.
                setFailure(null);
                announce("Showing the latest discussion; your reply is kept");
              }}
            >
              Review the latest first
            </Button>
          </div>
        </div>
      )}
      {failure?.code === "archived" && failure.continuationId && (
        <div
          role="alert"
          className="space-y-1 rounded border border-amber-500/40 bg-amber-500/10 p-1.5 text-[11px]"
        >
          <p>This note was archived. Your reply is kept.</p>
          <div className="flex gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              disabled={saving}
              onClick={() => void publishInContinuation(failure.continuationId!)}
            >
              Post reply in the continued note
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              onClick={() => selectAnnotation(failure.continuationId!)}
            >
              Open continued note
            </Button>
          </div>
        </div>
      )}
      {showArchive && (
        <ArchiveAndContinue
          annotation={annotation}
          pendingText={draft.text}
          reason={
            capacityFull
              ? "This discussion is full, so the reply was not added."
              : `This discussion is nearly full (${annotation.entryCount} of ${WEB_ANNOTATION_LIMITS.threadEntries} entries).`
          }
          onArchived={(continuationId, usedText) => {
            if (usedText) void draft.clear();
            selectAnnotation(continuationId);
          }}
        />
      )}
      {error &&
        !(capacityFull && showArchive) &&
        !(failure?.code === "archived" && failure.continuationId) && (
          <p role="alert" className="text-[11px] text-destructive">
            {error}
          </p>
        )}
    </div>
  );
}
