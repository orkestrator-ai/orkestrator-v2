import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import type { BrowserPreviewPendingCaptureDescriptor } from "@orkestrator/protocol/browser-preview";
import { WEB_ANNOTATION_LIMITS } from "@orkestrator/protocol/web-annotations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useWebAnnotationCache } from "@/hooks/useWebAnnotations";
import {
  captureDraftScope,
  captureIntent,
  editorIdFor,
} from "@/lib/web-annotations/capture-intents";
import { writeLocalDraft } from "@/lib/web-annotations/local-drafts";
import { AnnotationCaptureCard, expiryLabel } from "./AnnotationCaptureCard";
import { useAnnotationPanel } from "./panel-context";
import { unsavedRemainder, useAnnotationDraft } from "./useAnnotationDraft";

export function draftStatusLabel(status: string, localOnly = false): string {
  switch (status) {
    case "loading":
      return "Loading draft…";
    case "dirty":
      return localOnly ? "Unsaved — kept on this computer" : "Unsaved changes";
    case "saving":
      return "Saving draft…";
    case "saved":
      return "Draft saved (not published)";
    case "error":
      return localOnly
        ? "Draft not saved yet — kept on this computer and retried automatically"
        : "Draft not saved";
    case "conflict":
      return "Draft changed elsewhere";
    default:
      return "";
  }
}

function latestContentRevision(...revisions: Array<number | undefined>): number | undefined {
  const known = revisions.filter((revision): revision is number => revision !== undefined);
  return known.length > 0 ? Math.max(...known) : undefined;
}

/** The reply editor of a thread, where text typed during a save continues. */
export function replyEditorId(annotationId: string) {
  return editorIdFor(`reply:${annotationId}`);
}

/**
 * Trusted editor for a pending capture. The comment is typed here, never in
 * the page. "Saved" appears only after the backend receipt; a failure keeps
 * both the text and the pending capture with Retry and Discard.
 */
export function AnnotationEditor({
  descriptor,
  onClose,
}: {
  descriptor: BrowserPreviewPendingCaptureDescriptor;
  onClose: (reason: "done" | "saved" | "discarded", annotationId?: string) => void;
}) {
  const panel = useAnnotationPanel();
  const { capture, environmentId, features } = panel;
  const captureId = descriptor.captureId;
  const record = capture.activeCaptureId === captureId ? capture.activeCapture : null;
  const intent = captureIntent(captureId);
  const kind =
    intent?.kind === "result" || descriptor.purpose === "result"
      ? "result"
      : descriptor.annotationId
        ? "replace"
        : "create";
  const responsive = descriptor.responsive ?? null;
  const responsiveMembers = responsive
    ? capture.pending
        .filter((item) => item.responsive?.setId === responsive.setId)
        .sort((a, b) => (a.responsive?.index ?? 0) - (b.responsive?.index ?? 0))
    : [];
  const cache = useWebAnnotationCache(environmentId);
  // The open thread is refreshed after replies, so it can be newer than the
  // list summary; take the freshest known revision. When neither is cached,
  // the capture hook fetches it instead of guessing.
  const knownContentRevision = descriptor.annotationId
    ? latestContentRevision(
        cache.threads.get(descriptor.annotationId)?.data?.annotation.contentRevision,
        cache.summaries.get(descriptor.annotationId)?.contentRevision,
      )
    : undefined;
  // A recapture keeps the draft scope of the capture it replaced.
  const draft = useAnnotationDraft({
    environmentId,
    editorId: editorIdFor(`capture:${captureDraftScope(captureId)}`),
    context: { pendingCaptureId: captureId, annotationId: descriptor.annotationId },
    enabled: features.drafts && kind !== "result",
  });
  const [title, setTitle] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const saveState = capture.saveState(captureId);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const saveButtonRef = useRef<HTMLButtonElement | null>(null);
  const saving = saveState.status === "saving";
  // Saving while a redaction is being applied could upload unredacted pixels.
  const imageChanging = capture.imageChanging(captureId);

  // Focus flow: selecting a target moves focus into its editor, and so does
  // main handing keyboard focus back after a selection (`focus: "editor"`).
  const focusRequest = capture.editorFocusRequest;
  useEffect(() => {
    (textareaRef.current ?? saveButtonRef.current)?.focus();
  }, [captureId, focusRequest]);

  const submit = async (addAnother: boolean) => {
    setNotice(null);
    const body = draft.readText();
    if (kind === "create" && !body.trim()) {
      // An empty editor saves capture-only context as an unpublished backend
      // draft (naming this pending capture); publishing needs text. The
      // capture image itself stays on this computer until it expires, so the
      // expiry is stated rather than left to lapse silently.
      await draft.flush({ force: true });
      setNotice(
        `Kept as an unpublished draft. Add a comment to publish this note; until then the capture is not saved to Orkestrator. ${expiryLabel(descriptor.expiresAt)}.`,
      );
      panel.announce("Capture kept as a draft; add a comment to save the note");
      return;
    }
    await draft.flush();
    const input = {
      body,
      title,
      draftId: draft.draftId ?? undefined,
      expectedContentRevision: knownContentRevision,
    };
    const outcome = responsive
      ? await capture.saveResponsiveSet(responsive.setId, input)
      : await capture.save(captureId, input);
    if (!outcome.ok) {
      panel.announce(`Save failed: ${outcome.error}`);
      return;
    }
    // Only the published text is cleared. Anything typed while the save was
    // in flight continues in the saved thread's reply editor.
    const remainder = unsavedRemainder(body, draft.readText());
    void draft.clear();
    if (remainder && outcome.annotationId && kind !== "result") {
      writeLocalDraft(environmentId, replyEditorId(outcome.annotationId), remainder, 0);
    }
    panel.announce(
      kind === "result"
        ? "Result capture saved"
        : kind === "replace"
          ? "Target updated"
          : remainder
            ? "Note saved; your later text is kept as a reply draft"
            : "Note saved",
    );
    if (addAnother) {
      // Re-enter selection only after the backend acknowledged this note.
      onClose("saved");
      void capture.start(panel.captureMode);
      return;
    }
    onClose("saved", outcome.annotationId);
  };

  const done = () => {
    void draft.flush();
    if (capture.selecting) void capture.cancel();
    onClose("done");
  };

  const heading =
    kind === "result"
      ? "Capture current result"
      : kind === "replace"
        ? "Reselect target"
        : responsive
          ? "New note (responsive set)"
          : "New note";
  const canPublish = kind === "result" ? features.comparison || features.author : features.author;

  return (
    <section
      aria-label={heading}
      className="space-y-2 border-b border-border/70 p-3"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          done();
        }
      }}
    >
      <h3 className="text-xs font-semibold text-foreground">{heading}</h3>
      {responsive && (
        <div
          className="space-y-0.5 rounded border border-border/60 p-1.5 text-[11px]"
          data-responsive-set={responsive.setId}
        >
          <p className="font-medium">
            {responsiveMembers.length} widths captured one after another (not simultaneously):
          </p>
          <ul className="flex flex-wrap gap-1">
            {responsiveMembers.map((member) => (
              <li key={member.captureId}>
                <button
                  type="button"
                  className={
                    member.captureId === captureId
                      ? "rounded bg-primary/15 px-1.5 py-0.5"
                      : "rounded px-1.5 py-0.5 text-muted-foreground underline-offset-2 hover:underline"
                  }
                  aria-pressed={member.captureId === captureId}
                  aria-label={`Show the ${member.responsive?.viewportWidth ?? "?"} px capture`}
                  onClick={() => capture.openPending(member.captureId)}
                >
                  {member.responsive?.viewportWidth ?? "?"} px
                </button>
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground">
            Saving stores every width in this note, each with its own viewport and time.
          </p>
        </div>
      )}
      <AnnotationCaptureCard
        descriptor={descriptor}
        record={record}
        disabled={saving || saveState.status === "saved"}
        onRedact={(regions) => capture.applyRedaction(captureId, regions)}
        onExcludeImage={() => capture.excludeImage(captureId)}
        onRecapture={
          capture.desktopCapabilities?.features.recapture && features.capture
            ? () => void capture.recapture(captureId)
            : undefined
        }
        recapturing={capture.selecting}
      />
      {kind === "create" && (
        <Input
          value={title}
          onChange={(event) =>
            setTitle(event.target.value.slice(0, WEB_ANNOTATION_LIMITS.titleChars))
          }
          placeholder="Title (optional)"
          aria-label="Note title"
          className="h-8 text-xs"
        />
      )}
      {kind !== "result" && (
        <>
          <Textarea
            ref={textareaRef}
            value={draft.text}
            onChange={(event) => draft.setText(event.target.value)}
            maxLength={WEB_ANNOTATION_LIMITS.entryChars}
            rows={4}
            aria-label={`Comment for ${descriptor.targetLabel || "the selected target"}`}
            placeholder={
              kind === "replace"
                ? "Optional: explain what changed about the target"
                : "What should change here? This stays in Orkestrator until you choose an agent."
            }
            className="text-xs"
          />
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span aria-live="off">{draftStatusLabel(draft.status, draft.localOnly)}</span>
            <span>
              {draft.text.length}/{WEB_ANNOTATION_LIMITS.entryChars}
            </span>
          </div>
        </>
      )}
      {draft.conflict && (
        <div
          role="alert"
          className="space-y-1 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-[11px]"
        >
          <p>This draft was changed elsewhere. Your text is kept.</p>
          <p className="whitespace-pre-wrap text-muted-foreground">
            Other version: {draft.conflict.server || "(empty)"}
          </p>
          <div className="flex gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              onClick={() => draft.resolveConflict("keep-local")}
            >
              Keep my text
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              onClick={() => draft.resolveConflict("use-server")}
            >
              Use other version
            </Button>
          </div>
        </div>
      )}
      {!canPublish && features.mode === "read-only" && (
        <p className="text-[11px] text-amber-200">
          Read-only recovery mode: your text is kept as a draft, but new notes cannot be saved until
          annotations are enabled again.
        </p>
      )}
      {notice && (
        <p role="status" className="text-[11px] text-amber-200">
          {notice}
        </p>
      )}
      {saveState.status === "error" && (
        <div
          role="alert"
          className="space-y-1 rounded border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive"
        >
          <p>Not saved: {saveState.error}</p>
          <p className="text-muted-foreground">
            {saveState.retrying
              ? "Your comment and the capture are kept. Saving continues automatically when the connection returns."
              : "Your comment and the capture are kept."}
          </p>
          <div className="flex gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              onClick={() => void submit(false)}
            >
              Retry
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              onClick={() => {
                void capture.discard(captureId);
                void draft.clear();
                onClose("discarded");
              }}
            >
              Discard capture
            </Button>
          </div>
        </div>
      )}
      {saveState.status === "saved" && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-emerald-300">
          <CheckCircle2 className="h-3 w-3" aria-hidden />
          <span>
            Saved
            {saveState.ackPending
              ? " — the copy on this computer is cleared automatically on the next check."
              : ""}
          </span>
          {saveState.annotationId && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              onClick={() => onClose("saved", saveState.annotationId ?? undefined)}
            >
              Open note
            </Button>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        <Button
          ref={saveButtonRef}
          type="button"
          size="sm"
          className="h-7 px-2.5 text-xs"
          disabled={saving || imageChanging || !canPublish}
          onClick={() => void submit(false)}
        >
          {saving && <Loader2 className="mr-1 h-3 w-3 motion-safe:animate-spin" aria-hidden />}
          {kind === "result"
            ? "Attach to result"
            : kind === "replace"
              ? "Save new target"
              : responsive
                ? `Save note with ${responsiveMembers.length} widths`
                : "Save note"}
        </Button>
        {kind === "create" && !responsive && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="h-7 px-2.5 text-xs"
            disabled={saving || imageChanging || !features.capture}
            onClick={() => void submit(true)}
          >
            Save and add another
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 px-2.5 text-xs"
          onClick={done}
        >
          Done
        </Button>
        {saveState.status !== "error" && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="ml-auto h-7 px-2 text-xs text-muted-foreground"
            disabled={saving}
            onClick={() => {
              void capture.discard(captureId);
              void draft.clear();
              onClose("discarded");
            }}
          >
            Discard capture
          </Button>
        )}
      </div>
    </section>
  );
}
