import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Expand, ExternalLink, RefreshCw, X } from "lucide-react";
import { clampArtifactFrameHeight } from "@orkestrator/protocol/artifact-frame-channel";
import {
  FRAME_CHANNEL_POLICY,
  STATIC_PRESENTATION_POLICY,
} from "@orkestrator/protocol/rich-content-policy";
import type { ArtifactPublicationView } from "@orkestrator/protocol/transcript-artifact-commands";
import type { TranscriptArtifactRef } from "@orkestrator/protocol/transcript-artifacts";
import { openInBrowser } from "@/lib/backend";
import {
  artifactConversationStatus,
  isArtifactPermissionError,
  releaseArtifactSearchBody,
  withholdArtifactSearchBody,
  type ArtifactReadScope,
} from "@/lib/chat/artifact-requests";
import { useRichBlockVisibility, useRichRenderPriority } from "@/lib/chat/rich-render-priority";
import {
  useVerifiedEffectiveHtml,
  type VerifiedStaticDocument,
} from "@/lib/chat/static-html-document";
import { useRichViewField } from "@/stores/richContentViewStore";
import { useStaticFrameSlot, type StaticFrameRank } from "@/stores/staticHtmlFrameSlots";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ChatFindActiveContext, StaticDocumentFindContext } from "../chat-find-context";
import {
  StaticHtmlFrame,
  type StaticFrameEvents,
  type StaticFrameFailure,
} from "./StaticHtmlFrame";

/**
 * A published `html-static` revision shown as its actual verified document.
 *
 * The states are deliberately distinct: `loading`, `ready`, `deferred` (no
 * frame slot free), `unavailable` (over the display budget, or not readable),
 * `failed` (integrity, or the runtime gave up; retry is offered) and `revoked`
 * (protected content cleared; nothing protected is shown). Replay needs only
 * the stored bytes and this runtime: it never depends on the preview worker or
 * on the interactive host.
 */

type ReadFailure =
  "over-budget" | "incomplete" | "integrity" | "identity" | "missing" | "transport";

const READ_FAILURE_TEXT: Record<ReadFailure, string> = {
  "over-budget": `This report is larger than the ${STATIC_PRESENTATION_POLICY.maxDocumentBytes / 1024} KiB inline display budget, so the saved preview is shown. Source and export still have all of it.`,
  incomplete: "The document could not be read completely, so no part of it is shown.",
  integrity: "The stored document did not match its verification receipt, so it is not shown.",
  identity:
    "The stored document names a different revision than this publication, so it is not shown.",
  missing: "The verified document is not available for this revision.",
  transport: "The document could not be loaded.",
};

const FRAME_FAILURE_TEXT: Record<StaticFrameFailure, string> = {
  "too-large": READ_FAILURE_TEXT["over-budget"],
  "too-many-elements": `This report has more than ${STATIC_PRESENTATION_POLICY.maxElements} elements, the inline display limit, so the saved preview is shown. Source and export still have all of it.`,
  "invalid-render": "The document view could not start.",
  "render-failed": "The document could not be displayed by this version of the app.",
  timeout: "The document view did not respond.",
  reloaded: "The document view reloaded unexpectedly and was closed.",
  unstable: "The document kept changing size, so its live view was stopped.",
};

const UNRETRYABLE_FRAME_FAILURES: ReadonlySet<StaticFrameFailure> = new Set([
  "too-large",
  "too-many-elements",
]);

function readFailureOf(code: string | undefined): ReadFailure {
  switch (code) {
    case "static_over_budget":
      return "over-budget";
    case "static_incomplete":
      return "incomplete";
    case "static_integrity":
      return "integrity";
    case "static_identity":
      return "identity";
    case "not_found":
    case "storage_corrupt":
      return "missing";
    default:
      return "transport";
  }
}

function StatusNote({
  children,
  onRetry,
  action,
}: {
  children: ReactNode;
  onRetry?: () => void;
  action?: ReactNode;
}) {
  return (
    <p
      role="status"
      data-artifact-static-note="true"
      className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
    >
      <span>{children}</span>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1 underline"
        >
          <RefreshCw aria-hidden="true" className="size-3" /> Retry
        </button>
      ) : null}
      {action}
    </p>
  );
}

function LinkRequest({
  link,
  onDismiss,
}: {
  link: { href: string; hostname: string; label: string };
  onDismiss: () => void;
}) {
  return (
    <p
      data-artifact-link-request="true"
      className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
    >
      <span>This report asks to open a link.</span>
      <button
        type="button"
        className="inline-flex items-center gap-1 underline"
        title={`${link.label ? `${link.label} — ` : ""}${link.href}`}
        onClick={() => {
          onDismiss();
          void openInBrowser(link.href).catch(() => {});
        }}
      >
        <ExternalLink aria-hidden="true" className="size-3" />
        Open {link.hostname}
      </button>
      <button type="button" aria-label="Dismiss link request" onClick={onDismiss}>
        <X aria-hidden="true" className="size-3" />
      </button>
    </p>
  );
}

interface MountState {
  key: string;
  rendered: boolean;
  interacting: boolean;
  failure: StaticFrameFailure | null;
}

/**
 * Frame lifecycle state, tied to the identity of the mount it describes so a
 * new document or a retry starts clean with no synchronizing effect.
 */
function useMountState(key: string) {
  const [state, setState] = useState<MountState>({
    key,
    rendered: false,
    interacting: false,
    failure: null,
  });
  const current: MountState =
    state.key === key ? state : { key, rendered: false, interacting: false, failure: null };
  const update = useCallback(
    (patch: Partial<MountState>) =>
      setState((previous) => ({
        ...(previous.key === key
          ? previous
          : { key, rendered: false, interacting: false, failure: null }),
        ...patch,
      })),
    [key],
  );
  return [current, update] as const;
}

export function StaticHtmlArtifactView({
  artifactRef,
  view,
  scope,
  occurrenceKey,
  preview,
  expanded,
  onExpand,
  onCloseExpanded,
  onDocumentText,
}: {
  artifactRef: TranscriptArtifactRef;
  view: ArtifactPublicationView;
  scope: ArtifactReadScope & { backendId: string };
  occurrenceKey: string;
  /** The saved preview, shown while loading, while deferred and as a fallback. */
  preview: ReactNode;
  expanded: boolean;
  onExpand: () => void;
  onCloseExpanded: () => void;
  /** The text a frame reported for Find; null when this card can no longer show it. */
  onDocumentText: (text: string | null) => void;
}) {
  const documentFind = useContext(StaticDocumentFindContext);
  const activeRow = useContext(ChatFindActiveContext);
  const findQuery = documentFind?.query ?? null;
  const findOccurrence =
    activeRow && documentFind?.activePublicationId === artifactRef.publicationId
      ? documentFind.activeOccurrence
      : null;
  const { observe, visibility } = useRichBlockVisibility();
  const { priority } = useRichRenderPriority(visibility);
  const visible = priority === "visible";
  // Nothing is read or framed for a block the reader has not reached.
  const [reached, setReached] = useState(visible || expanded);
  if ((visible || expanded) && !reached) setReached(true);

  const revoked = artifactConversationStatus(scope) === "revoked";
  const expectedSha256 = view.source.effectiveSha256;
  const verified = useVerifiedEffectiveHtml(
    scope,
    artifactRef,
    expectedSha256,
    reached && !revoked,
  );
  const ready: VerifiedStaticDocument | null = verified.status === "ready" ? verified.value : null;
  // A card that cannot display its document keeps Find's index from writing
  // the stored text back (`useStaticDocumentSearchIndex`); a frame that
  // displays it again releases it.
  const { publicationId, artifactId, revision } = artifactRef;
  const { backendId, environmentId, logicalSessionKey } = scope;
  const withholdText = useCallback(() => {
    withholdArtifactSearchBody({ publicationId, artifactId, revision }, occurrenceKey, {
      backendId,
      environmentId,
      logicalSessionKey,
    });
    onDocumentText(null);
  }, [
    artifactId,
    backendId,
    environmentId,
    logicalSessionKey,
    occurrenceKey,
    onDocumentText,
    publicationId,
    revision,
  ]);
  const releaseText = useCallback(
    () => releaseArtifactSearchBody({ publicationId, artifactId, revision }, occurrenceKey),
    [artifactId, occurrenceKey, publicationId, revision],
  );
  // Text from an earlier visit is not a fallback for a read that now fails.
  const readFailed = verified.status === "error";
  useEffect(() => {
    if (readFailed) withholdText();
  }, [readFailed, withholdText]);

  const [attempt, setAttempt] = useState(0);
  const baseKey = `${scope.generation}:${expectedSha256}:${attempt}`;
  const [inline, updateInline] = useMountState(`inline:${baseKey}`);
  const [dialog, updateDialog] = useMountState(`dialog:${baseKey}`);
  const [link, setLink] = useState<{ href: string; hostname: string; label: string } | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const attachContainer = useCallback(
    (element: HTMLDivElement | null) => {
      container.current = element;
      return observe(element);
    },
    [observe],
  );

  const firstCapture = view.receipt.captures[0] ?? null;
  const verifiedAppearance = view.receipt.profile?.theme === "dark" ? "dark" : "light";
  const [measuredHeight, setMeasuredHeight] = useRichViewField(occurrenceKey, "measuredHeight", 0);
  const estimatedHeight = clampArtifactFrameHeight(
    measuredHeight > 0 ? measuredHeight : (firstCapture?.height ?? 0),
  );

  const failed = inline.failure !== null;
  const inlineRank: StaticFrameRank | null =
    !ready || failed || expanded || revoked
      ? null
      : inline.interacting
        ? "interacting"
        : visible
          ? "visible"
          : "held";
  const slotKey = `${occurrenceKey}#document`;
  const inlineGranted = useStaticFrameSlot(slotKey, inlineRank);
  const dialogRank: StaticFrameRank | null =
    expanded && ready && dialog.failure === null && !revoked ? "expanded" : null;
  const dialogGranted = useStaticFrameSlot(`${occurrenceKey}#expanded`, dialogRank);

  const retryRead = verified.retry;
  const retry = useCallback(() => {
    setLink(null);
    setOverflowing(false);
    setAttempt((value) => value + 1);
    retryRead();
  }, [retryRead]);

  const inlineEvents = useMemo<StaticFrameEvents>(
    () => ({
      onRendered: () => {
        releaseText();
        updateInline({ rendered: true });
      },
      onReleased: () => updateInline({ rendered: false, interacting: false }),
      onHeight: (height) => {
        setOverflowing(height > FRAME_CHANNEL_POLICY.maxInlineHeight);
        setMeasuredHeight(height);
      },
      onFailure: (failure) => {
        withholdText();
        updateInline({ failure, rendered: false, interacting: false });
      },
      onText: onDocumentText,
      onInteraction: (interacting) => updateInline({ interacting }),
      onLink: setLink,
      onEscape: () => container.current?.focus(),
    }),
    [onDocumentText, releaseText, setMeasuredHeight, updateInline, withholdText],
  );
  const dialogEvents = useMemo<StaticFrameEvents>(
    () => ({
      onRendered: () => {
        releaseText();
        updateDialog({ rendered: true });
      },
      onReleased: () => updateDialog({ rendered: false }),
      onHeight: () => {},
      onFailure: (failure) => {
        withholdText();
        updateDialog({ failure, rendered: false });
      },
      onText: onDocumentText,
      onInteraction: () => {},
      onLink: setLink,
      onEscape: onCloseExpanded,
    }),
    [onCloseExpanded, onDocumentText, releaseText, updateDialog, withholdText],
  );

  if (revoked) {
    return (
      <p role="note" data-artifact-static-state="revoked" className="text-xs text-muted-foreground">
        Access to this conversation's content ended, so this report is no longer shown.
      </p>
    );
  }

  const readFailure = verified.status === "error" ? readFailureOf(verified.code) : null;
  const permissionFailure =
    verified.status === "error" && isArtifactPermissionError({ code: verified.code });
  const state = !reached
    ? "loading"
    : readFailure === "over-budget" || readFailure === "missing"
      ? "unavailable"
      : verified.status === "error"
        ? "failed"
        : !ready
          ? "loading"
          : failed
            ? UNRETRYABLE_FRAME_FAILURES.has(inline.failure!)
              ? "unavailable"
              : "failed"
            : expanded
              ? "expanded"
              : inlineGranted
                ? "ready"
                : "deferred";

  const frameShown = state === "ready" && ready !== null;
  const showPreview = !frameShown || !inline.rendered;
  const note =
    state === "unavailable"
      ? readFailure
        ? READ_FAILURE_TEXT[readFailure]
        : FRAME_FAILURE_TEXT[inline.failure!]
      : state === "failed"
        ? permissionFailure
          ? READ_FAILURE_TEXT.missing
          : readFailure
            ? READ_FAILURE_TEXT[readFailure]
            : FRAME_FAILURE_TEXT[inline.failure!]
        : null;

  return (
    <div
      ref={attachContainer}
      tabIndex={-1}
      className="outline-none"
      data-artifact-static-state={state}
    >
      {link ? <LinkRequest link={link} onDismiss={() => setLink(null)} /> : null}
      {note ? (
        <StatusNote onRetry={state === "failed" ? retry : undefined}>{note}</StatusNote>
      ) : null}
      {state === "deferred" ? (
        <StatusNote
          action={
            <button
              type="button"
              onClick={onExpand}
              className="inline-flex items-center gap-1 underline"
            >
              <Expand aria-hidden="true" className="size-3" /> Open this report
            </button>
          }
        >
          Saved preview: {STATIC_PRESENTATION_POLICY.maxFramesPerWindow} reports are already open in
          this window.
        </StatusNote>
      ) : null}
      {state === "loading" ? (
        <p aria-live="polite" className="mb-2 text-xs text-muted-foreground">
          Loading document…
        </p>
      ) : null}
      {state === "expanded" ? (
        <p className="mb-2 text-xs text-muted-foreground">Open in the expanded view.</p>
      ) : null}
      <div
        className="relative"
        style={showPreview && measuredHeight > 0 ? { minHeight: estimatedHeight } : undefined}
      >
        {showPreview ? preview : null}
        {frameShown ? (
          <StaticHtmlFrame
            key={inline.key}
            html={ready.html}
            title={artifactRef.title}
            verifiedAppearance={verifiedAppearance}
            mode="inline"
            height={estimatedHeight}
            rendered={inline.rendered}
            findQuery={findQuery}
            findOccurrence={findOccurrence}
            events={inlineEvents}
          />
        ) : null}
      </div>
      {frameShown && inline.rendered && overflowing ? (
        <div className="mt-2">
          <StatusNote
            action={
              <button
                type="button"
                onClick={onExpand}
                className="inline-flex items-center gap-1 underline"
              >
                <Expand aria-hidden="true" className="size-3" /> Expand
              </button>
            }
          >
            This report is taller than the {FRAME_CHANNEL_POLICY.maxInlineHeight} px inline limit;
            scroll inside it, or expand it.
          </StatusNote>
        </div>
      ) : null}
      {expanded ? (
        <Dialog open onOpenChange={(open) => (open ? undefined : onCloseExpanded())}>
          <DialogContent size="6xl">
            <DialogTitle>{artifactRef.title}</DialogTitle>
            <DialogDescription>
              Verified document of revision {artifactRef.revision}. Authored scripts do not run, and
              links open only when you confirm them.
            </DialogDescription>
            {link ? <LinkRequest link={link} onDismiss={() => setLink(null)} /> : null}
            {dialog.failure ? (
              <StatusNote
                onRetry={UNRETRYABLE_FRAME_FAILURES.has(dialog.failure) ? undefined : retry}
              >
                {FRAME_FAILURE_TEXT[dialog.failure]}
              </StatusNote>
            ) : null}
            {verified.status === "error" && readFailure ? (
              <StatusNote onRetry={state === "failed" ? retry : undefined}>
                {READ_FAILURE_TEXT[readFailure]}
              </StatusNote>
            ) : null}
            <div className="relative h-[75vh] min-h-0 overflow-hidden">
              {ready && dialogGranted && !dialog.failure ? (
                <StaticHtmlFrame
                  key={dialog.key}
                  html={ready.html}
                  title={artifactRef.title}
                  verifiedAppearance={verifiedAppearance}
                  mode="expanded"
                  height={0}
                  rendered={dialog.rendered}
                  findQuery={findQuery}
                  findOccurrence={findOccurrence}
                  events={dialogEvents}
                />
              ) : null}
              {!dialog.rendered ? <div className="h-full overflow-auto">{preview}</div> : null}
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
