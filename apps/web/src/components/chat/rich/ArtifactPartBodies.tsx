import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  Code2,
  Download,
  Expand,
  Image as ImageIcon,
  Info,
  Play,
  Printer,
  RefreshCw,
  Square,
} from "lucide-react";
import { parseChartSpec } from "@orkestrator/protocol/chart-spec";
import {
  validateWorkflowSnapshot,
  type WorkflowSnapshotV1,
} from "@orkestrator/protocol/workflow-snapshot";
import type { TranscriptArtifactRef } from "@orkestrator/protocol/transcript-artifacts";
import type {
  ArtifactPublicationView,
  ArtifactRepresentationResponse,
} from "@orkestrator/protocol/transcript-artifact-commands";
import { clampArtifactFrameHeight } from "@orkestrator/protocol/artifact-frame-channel";
import {
  isCurrentArtifactScopeGeneration,
  readWholeRepresentation,
  rememberArtifactSearchBody,
  useArtifactRepresentation,
  type ArtifactReadScope,
  type ArtifactRequestState,
} from "@/lib/chat/artifact-requests";
import {
  artifactFilename,
  defaultPrintPaper,
  downloadBase64,
  downloadText,
  printStaticCapture,
} from "@/lib/chat/artifact-download";
import { sanitizeSvg } from "@/lib/chat/svg-sanitize";
import { artifactBodySearchText } from "@/lib/chat/rich-search-text";
import { useTranscriptArtifactCapabilities } from "@/hooks/useTranscriptArtifactCapabilities";
import { useRichViewField, type RichViewChoice } from "@/stores/richContentViewStore";
import {
  LIVE_HOST_INVALIDATION_REASONS,
  useArtifactLiveHostStore,
} from "@/stores/artifactLiveHostStore";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { NativeChart } from "./NativeChart";
import { NativeChartSource } from "./NativeChartData";
import { WorkflowSnapshotCard } from "./WorkflowSnapshotCard";
import { ArtifactLivePlaceholder } from "./ArtifactLiveHost";
import { RichSearchMirror } from "./RichMarkdownBlocks.shared";
import { ArtifactWorkerPrepareAction } from "./ArtifactWorkerPrepareAction";
import { readTranscriptArtifactRepresentation } from "@/lib/backend/transcript-artifacts";
import { artifactErrorInfo } from "@/lib/chat/artifact-requests";

/**
 * Per-kind bodies of a published artifact card. Every body reads exact
 * representations by publication through the authorized scope and checks
 * that the response names the same artifact revision before showing it.
 */

interface BodyProps {
  artifactRef: TranscriptArtifactRef;
  scope: ArtifactReadScope & { backendId: string };
  occurrenceKey: string;
}

export function artifactVerificationLabels(view: ArtifactPublicationView): {
  profile: string;
  semantics: string | null;
} {
  const profile = view.receipt.profile;
  let profileLabel: string;
  if (profile) {
    profileLabel = `Verified at ${profile.theme} ${profile.viewport.width}×${profile.viewport.height}`;
  } else if (view.kind === "chart") {
    profileLabel = "Validated by the native chart renderer";
  } else if (view.kind === "mermaid") {
    profileLabel = "Rendered under the strict diagram policy";
  } else if (view.kind === "workflow-snapshot") {
    profileLabel = "Captured from the workflow service";
  } else {
    profileLabel = "Preview profile not recorded";
  }
  if (view.kind !== "html-static" && view.kind !== "html-interactive")
    return { profile: profileLabel, semantics: null };
  const probes = view.receipt.probeSummary;
  const semantics =
    view.receipt.semantics === "probes-passed" && probes && probes.total > 0
      ? `Interactions verified by ${probes.passed} probe${probes.passed === 1 ? "" : "s"}`
      : "Semantics not assessed";
  return { profile: profileLabel, semantics };
}

function sameRevision(
  response: ArtifactRepresentationResponse,
  artifactRef: TranscriptArtifactRef,
): boolean {
  return (
    response.artifactId === artifactRef.artifactId && response.revision === artifactRef.revision
  );
}

function BodyStatus({
  state,
  label,
}: {
  state: ArtifactRequestState<unknown> & { retry: () => void };
  label: string;
}) {
  if (state.status === "error") {
    return (
      <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground" role="note">
        <span>
          {state.code === "not_found"
            ? "This representation is not available."
            : `${label} could not be loaded.`}
        </span>
        <button
          type="button"
          onClick={state.retry}
          className="inline-flex items-center gap-1 underline"
        >
          <RefreshCw aria-hidden="true" className="size-3" /> Retry
        </button>
      </div>
    );
  }
  return (
    <div className="px-3 py-3 text-xs text-muted-foreground" aria-live="polite">
      {label}…
    </div>
  );
}

function RevisionMismatch() {
  return (
    <p role="note" className="px-3 py-3 text-xs text-muted-foreground">
      The stored representation names a different revision than this publication, so it is not
      shown.
    </p>
  );
}

function BodyToolbar({ children }: { children: ReactNode }) {
  return (
    <div
      role="toolbar"
      aria-label="Artifact actions"
      data-rich-chrome="true"
      className="flex select-none flex-wrap items-center gap-1 px-3 pt-2 text-[11px]"
    >
      {children}
    </div>
  );
}

function ToolbarAction({
  label,
  onClick,
  pressed,
  disabled,
  icon,
  children,
  title,
}: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  disabled?: boolean;
  icon?: ReactNode;
  children?: ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={title ?? label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded border border-border px-1.5 text-foreground outline-none hover:bg-elevated focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-3",
        pressed && "bg-elevated",
      )}
    >
      {icon}
      {children ?? label}
    </button>
  );
}

function downloadRepresentation(
  scope: ArtifactReadScope,
  artifactRef: TranscriptArtifactRef,
  representation: "source" | "rendered-svg",
  extension: string,
  mimeType: string,
): void {
  void readWholeRepresentation(scope, artifactRef.publicationId, representation)
    .then((response) => {
      if (!isCurrentArtifactScopeGeneration(scope) || !sameRevision(response, artifactRef)) return;
      if (response.encoding !== "utf8") throw new Error("not text");
      const data =
        representation === "rendered-svg" ? sanitizeSvg(response.data).svg : response.data;
      downloadText(data, artifactFilename(artifactRef.title, extension), mimeType);
    })
    .catch(() => toast.error("Download failed"));
}

/**
 * Download the backend's PDF of this exact revision: printed by the isolated
 * preview worker under the fixed print profile on first request, then
 * stored. Always saved as an attachment; never opened or printed in-page.
 */
function downloadPdfRepresentation(
  scope: ArtifactReadScope,
  artifactRef: TranscriptArtifactRef,
  onSettled: () => void,
): void {
  const paper = defaultPrintPaper();
  const pending = toast.loading("Preparing PDF…");
  void readTranscriptArtifactRepresentation({
    environmentId: scope.environmentId,
    logicalSessionKey: scope.logicalSessionKey,
    publicationId: artifactRef.publicationId,
    representation: "pdf",
    paper,
  })
    .then((response) => {
      if (!isCurrentArtifactScopeGeneration(scope) || !sameRevision(response, artifactRef)) {
        toast.dismiss(pending);
        return;
      }
      if (
        response.encoding !== "base64" ||
        response.mimeType !== "application/pdf" ||
        response.representation !== "pdf"
      )
        throw new Error("The backend did not return a PDF");
      downloadBase64(response.data, artifactFilename(artifactRef.title, "pdf"), "application/pdf");
      toast.success(
        `PDF saved (${response.print?.pageCount ?? "?"} page${response.print?.pageCount === 1 ? "" : "s"}, ${paper === "letter" ? "Letter" : "A4"})`,
        { id: pending },
      );
    })
    .catch((error: unknown) => {
      toast.error(`PDF unavailable: ${artifactErrorInfo(error).message}`, {
        id: pending,
        description: "Print saved preview remains available.",
      });
    })
    .finally(onSettled);
}

/**
 * Publish the body text this card shows to find's synchronous cache, and
 * withdraw it when the card stops showing it (e.g. Mermaid back to preview).
 * Unmounting (scrolling away) keeps it: the body is still the card's content.
 */
function useArtifactSearchBody(artifactRef: TranscriptArtifactRef, text: string | null): void {
  const { publicationId, artifactId, revision } = artifactRef;
  useEffect(() => {
    rememberArtifactSearchBody({ publicationId, artifactId, revision }, text);
  }, [artifactId, publicationId, revision, text]);
}

/**
 * The loaded body's searchable labels as the card's second search root. The
 * drawing itself is excluded from find; this hidden mirror holds exactly the
 * text find's projection indexes for the body.
 */
function BodySearchRoot({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <div data-agent-chat-search-content="true" data-artifact-search-body="true">
      <RichSearchMirror text={text} />
    </div>
  );
}

export function ChartArtifactBody({ artifactRef, scope, occurrenceKey }: BodyProps) {
  const representation = useArtifactRepresentation(scope, artifactRef.publicationId, "chart-json");
  const parsed = useMemo(
    () => (representation.status === "ready" ? parseChartSpec(representation.value.data) : null),
    [representation],
  );
  const searchText = useMemo(
    () =>
      representation.status === "ready" &&
      sameRevision(representation.value, artifactRef) &&
      parsed?.ok
        ? artifactBodySearchText("chart", representation.value.data)
        : null,
    [artifactRef, parsed, representation],
  );
  useArtifactSearchBody(artifactRef, searchText);
  if (representation.status !== "ready")
    return <BodyStatus state={representation} label="Loading chart data" />;
  if (!sameRevision(representation.value, artifactRef)) return <RevisionMismatch />;
  if (!parsed || !parsed.ok) {
    return (
      <div>
        <p role="note" className="px-3 pt-2 text-xs text-muted-foreground">
          The stored chart specification did not validate in this client
          {parsed && !parsed.ok
            ? `: ${parsed.errors
                .map((error) => `${error.path}: ${error.message}`)
                .slice(0, 5)
                .join("; ")}`
            : ""}
          .
        </p>
        <NativeChartSource source={representation.value.data} />
      </div>
    );
  }
  return (
    <div className="px-2 pb-2">
      <div data-rich-search-exclude="true">
        <NativeChart
          spec={parsed.value}
          viewKey={occurrenceKey}
          source={representation.value.data}
          provenance={{ kind: "published", revision: artifactRef.revision }}
        />
      </div>
      <BodySearchRoot text={searchText} />
    </div>
  );
}

export function MermaidArtifactBody({ artifactRef, scope, occurrenceKey }: BodyProps) {
  const [view, setView] = useRichViewField(occurrenceKey, "view", "preview" as RichViewChoice);
  const showSource = view === "source";
  const svg = useArtifactRepresentation(scope, artifactRef.publicationId, "rendered-svg", {
    enabled: !showSource,
  });
  const source = useArtifactRepresentation(scope, artifactRef.publicationId, "source", {
    enabled: showSource,
  });
  // Source text is searchable only while the source view shows it.
  const sourceSearchText =
    showSource && source.status === "ready" && sameRevision(source.value, artifactRef)
      ? artifactBodySearchText("mermaid-source", source.value.data)
      : null;
  useArtifactSearchBody(artifactRef, sourceSearchText);
  const sanitized = useMemo(() => {
    if (svg.status !== "ready" || !sameRevision(svg.value, artifactRef)) return null;
    try {
      // Sanitized again here: stored output is never trusted into the application DOM.
      return { ok: true as const, svg: sanitizeSvg(svg.value.data).svg };
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof Error ? error.message : "Invalid SVG",
      };
    }
  }, [artifactRef, svg]);

  return (
    <div>
      <BodyToolbar>
        <ToolbarAction
          label="Diagram"
          pressed={!showSource}
          onClick={() => setView("preview")}
          icon={<ImageIcon aria-hidden="true" />}
        />
        <ToolbarAction
          label="Source"
          pressed={showSource}
          onClick={() => setView("source")}
          icon={<Code2 aria-hidden="true" />}
        />
        <ToolbarAction
          label="Download SVG"
          onClick={() =>
            downloadRepresentation(scope, artifactRef, "rendered-svg", "svg", "image/svg+xml")
          }
          icon={<Download aria-hidden="true" />}
        />
        <ToolbarAction
          label="Download source"
          onClick={() =>
            downloadRepresentation(scope, artifactRef, "source", "mmd", "text/plain;charset=utf-8")
          }
          icon={<Download aria-hidden="true" />}
        />
      </BodyToolbar>
      {showSource ? (
        source.status === "ready" ? (
          sameRevision(source.value, artifactRef) ? (
            <div data-agent-chat-search-content="true" data-artifact-search-body="true">
              <NativeChartSource source={source.value.data} />
            </div>
          ) : (
            <RevisionMismatch />
          )
        ) : (
          <BodyStatus state={source} label="Loading source" />
        )
      ) : svg.status !== "ready" ? (
        <BodyStatus state={svg} label="Loading diagram" />
      ) : !sanitized ? (
        <RevisionMismatch />
      ) : sanitized.ok ? (
        <div
          role="img"
          aria-label={`Diagram: ${artifactRef.title}`}
          data-artifact-mermaid="true"
          className="max-h-[70vh] overflow-auto p-3 [&_svg]:h-auto [&_svg]:max-w-full"
          dangerouslySetInnerHTML={{ __html: sanitized.svg }}
        />
      ) : (
        <p role="note" className="px-3 py-3 text-xs text-muted-foreground">
          The stored diagram failed the SVG safety policy ({sanitized.message}). Use Source to
          inspect it.
        </p>
      )}
    </div>
  );
}

export function WorkflowArtifactBody({ artifactRef, scope, occurrenceKey }: BodyProps) {
  const representation = useArtifactRepresentation(
    scope,
    artifactRef.publicationId,
    "workflow-json",
  );
  const parsed = useMemo((): { ok: true; value: WorkflowSnapshotV1 } | { ok: false } | null => {
    if (representation.status !== "ready") return null;
    try {
      const result = validateWorkflowSnapshot(JSON.parse(representation.value.data));
      return result.ok ? { ok: true, value: result.value } : { ok: false };
    } catch {
      return { ok: false };
    }
  }, [representation]);
  const searchText = useMemo(
    () =>
      representation.status === "ready" &&
      sameRevision(representation.value, artifactRef) &&
      parsed?.ok
        ? artifactBodySearchText("workflow-snapshot", representation.value.data)
        : null,
    [artifactRef, parsed, representation],
  );
  useArtifactSearchBody(artifactRef, searchText);
  if (representation.status !== "ready")
    return <BodyStatus state={representation} label="Loading workflow snapshot" />;
  if (!sameRevision(representation.value, artifactRef)) return <RevisionMismatch />;
  if (!parsed || !parsed.ok) {
    return (
      <p role="note" className="px-3 py-3 text-xs text-muted-foreground">
        The stored workflow snapshot did not validate in this client and is not drawn.
      </p>
    );
  }
  return (
    <div className="px-2 pb-2">
      <div data-rich-search-exclude="true">
        <WorkflowSnapshotCard
          snapshot={parsed.value}
          viewKey={occurrenceKey}
          environmentId={scope.environmentId}
        />
      </div>
      <BodySearchRoot text={searchText} />
    </div>
  );
}

const SOURCE_DISPLAY_CHARACTERS = 200_000;

export function HtmlArtifactBody({
  artifactRef,
  view,
  scope,
  occurrenceKey,
}: BodyProps & { view: ArtifactPublicationView }) {
  const [choice, setChoice] = useRichViewField(occurrenceKey, "view", "preview" as RichViewChoice);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [enlarged, setEnlarged] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const showSource = choice === "source";
  const firstCapture = view.receipt.captures[0] ?? null;
  const capture = useArtifactRepresentation(scope, artifactRef.publicationId, "capture", {
    enabled: firstCapture !== null,
    captureIndex: 0,
  });
  const source = useArtifactRepresentation(scope, artifactRef.publicationId, "source", {
    enabled: showSource,
  });
  const captureBase64 =
    capture.status === "ready" &&
    sameRevision(capture.value, artifactRef) &&
    capture.value.encoding === "base64" &&
    capture.value.mimeType === "image/png"
      ? capture.value.data
      : null;
  const captureUrl = captureBase64 ? `data:image/png;base64,${captureBase64}` : null;
  const interactive = artifactRef.kind === "html-interactive";
  const capabilities = useTranscriptArtifactCapabilities();
  const liveEnabled = Boolean(
    capabilities?.liveInteractive && capabilities.rolloutFlags.liveInteractive,
  );
  const live = useArtifactLiveHostStore((state) =>
    state.active?.target.occurrenceKey === occurrenceKey ? state.active : null,
  );
  const ended = useArtifactLiveHostStore((state) =>
    state.ended?.occurrenceKey === occurrenceKey ? state.ended : null,
  );
  const request = useArtifactLiveHostStore((state) => state.request);
  const stop = useArtifactLiveHostStore((state) => state.stop);
  const invalidate = useArtifactLiveHostStore((state) => state.invalidate);
  const clearEnded = useArtifactLiveHostStore((state) => state.clearEnded);

  // A scope change (session replaced) invalidates this occurrence's live channel.
  useEffect(() => {
    if (live && live.target.scope.generation !== scope.generation) {
      invalidate(LIVE_HOST_INVALIDATION_REASONS.sessionReplaced);
    }
  }, [invalidate, live, scope.generation]);

  const runInteractive = () => {
    request({
      occurrenceKey,
      publicationId: artifactRef.publicationId,
      artifactId: artifactRef.artifactId,
      revision: artifactRef.revision,
      title: artifactRef.title,
      scope: {
        backendId: scope.backendId,
        environmentId: scope.environmentId,
        logicalSessionKey: scope.logicalSessionKey,
        generation: scope.generation,
      },
      ...(captureUrl ? { previewDataUrl: captureUrl } : {}),
      ...(firstCapture ? { initialHeight: clampArtifactFrameHeight(firstCapture.height) } : {}),
    });
  };

  const liveInline = live !== null && live.placement === "inline";
  const preview = captureUrl ? (
    <img
      src={captureUrl}
      alt={`Saved preview of ${artifactRef.title}`}
      width={firstCapture?.width}
      height={firstCapture?.height}
      data-artifact-capture="true"
      className="h-auto max-w-full rounded border border-border"
    />
  ) : firstCapture === null ? (
    <p className="text-xs text-muted-foreground">
      No saved preview was recorded for this revision.
    </p>
  ) : (
    <BodyStatus state={capture} label="Loading saved preview" />
  );

  return (
    <div>
      <BodyToolbar>
        {interactive ? (
          live ? (
            <ToolbarAction
              label="Stop interactive"
              onClick={stop}
              icon={<Square aria-hidden="true" />}
            />
          ) : (
            <ToolbarAction
              label="Run interactive"
              onClick={runInteractive}
              disabled={!liveEnabled}
              title={
                liveEnabled
                  ? "Run this artifact in an isolated live view"
                  : "Interactive viewing is not enabled on this backend"
              }
              icon={<Play aria-hidden="true" />}
            />
          )
        ) : null}
        <ToolbarAction
          label="Preview"
          pressed={!showSource}
          onClick={() => setChoice("preview")}
          icon={<ImageIcon aria-hidden="true" />}
        />
        <ToolbarAction
          label="Source"
          pressed={showSource}
          onClick={() => setChoice("source")}
          icon={<Code2 aria-hidden="true" />}
        />
        <ToolbarAction
          label="Enlarge preview"
          disabled={!captureUrl}
          onClick={() => setEnlarged(true)}
          icon={<Expand aria-hidden="true" />}
        />
        <ToolbarAction
          label="Download PNG"
          disabled={!captureBase64}
          onClick={() =>
            captureBase64 &&
            downloadBase64(captureBase64, artifactFilename(artifactRef.title, "png"), "image/png")
          }
          icon={<Download aria-hidden="true" />}
        />
        <ToolbarAction
          label="Print saved preview"
          disabled={!captureBase64}
          onClick={() => {
            if (!captureBase64) return;
            try {
              printStaticCapture(captureBase64, artifactRef.title);
            } catch {
              toast.error("Printing is not available here");
            }
          }}
          icon={<Printer aria-hidden="true" />}
        />
        <ToolbarAction
          label="Download PDF"
          title="PDF of this exact revision, printed in the isolated preview worker"
          disabled={pdfBusy}
          onClick={() => {
            setPdfBusy(true);
            downloadPdfRepresentation(scope, artifactRef, () => setPdfBusy(false));
          }}
          icon={<Download aria-hidden="true" />}
        />
        <ToolbarAction
          label="Download HTML source — runs outside Orkestrator's isolation"
          title="HTML source — runs outside Orkestrator's isolation once saved"
          onClick={() =>
            downloadRepresentation(scope, artifactRef, "source", "html", "application/octet-stream")
          }
          icon={<Download aria-hidden="true" />}
        >
          HTML source
        </ToolbarAction>
        <ToolbarAction
          label="Diagnostics"
          pressed={showDiagnostics}
          onClick={() => setShowDiagnostics((value) => !value)}
          icon={<Info aria-hidden="true" />}
        />
      </BodyToolbar>
      <div className="px-3 py-2">
        {showSource ? (
          source.status === "ready" ? (
            sameRevision(source.value, artifactRef) ? (
              <>
                <NativeChartSource source={source.value.data.slice(0, SOURCE_DISPLAY_CHARACTERS)} />
                {source.value.data.length > SOURCE_DISPLAY_CHARACTERS ||
                source.value.nextOffsetBytes !== null ? (
                  <p className="text-[11px] text-muted-foreground">
                    Source truncated for display; download it for the full text.
                  </p>
                ) : null}
              </>
            ) : (
              <RevisionMismatch />
            )
          ) : (
            <BodyStatus state={source} label="Loading source" />
          )
        ) : (
          <>
            {!live && ended ? (
              <p
                role="status"
                data-artifact-live-ended="true"
                className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
              >
                <span>Interactive view closed: {ended.reason} Showing the saved preview.</span>
                <button
                  type="button"
                  className="underline"
                  onClick={() => clearEnded(occurrenceKey)}
                >
                  Dismiss
                </button>
              </p>
            ) : null}
            {live ? <ArtifactLivePlaceholder occurrenceKey={occurrenceKey} /> : null}
            {!liveInline ? preview : null}
          </>
        )}
        {showDiagnostics ? <ArtifactDiagnostics view={view} /> : null}
        {interactive ? <ArtifactWorkerPrepareAction /> : null}
      </div>
      {enlarged && captureUrl ? (
        <Dialog open onOpenChange={setEnlarged}>
          <DialogContent size="6xl">
            <DialogTitle>{artifactRef.title}</DialogTitle>
            <DialogDescription>
              Saved preview of revision {artifactRef.revision}. This image is static.
            </DialogDescription>
            <img
              src={captureUrl}
              alt={`Saved preview of ${artifactRef.title}`}
              className="h-auto max-w-full"
            />
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

function ArtifactDiagnostics({ view }: { view: ArtifactPublicationView }) {
  const { receipt, source } = view;
  const rows: Array<[string, string]> = [
    ["Receipt", receipt.receiptId],
    ["Verified", receipt.completedAt],
    [
      "Profile",
      receipt.profile
        ? `${receipt.profile.theme}, ${receipt.profile.viewport.width}×${receipt.profile.viewport.height}`
        : "not recorded",
    ],
    [
      "Captures",
      receipt.captures
        .map((capture) => `${capture.width}×${capture.height} (${capture.byteLength} bytes)`)
        .join(", ") || "none",
    ],
    [
      "Interaction probes",
      receipt.probeSummary
        ? `${receipt.probeSummary.passed} of ${receipt.probeSummary.total} passed`
        : "none declared",
    ],
    ["Semantics", receipt.semantics === "probes-passed" ? "probes passed" : "not assessed"],
    ["Source", `${source.byteLength} bytes · sha256 ${source.sha256}`],
    ["Displayed document", `sha256 ${source.effectiveSha256}`],
  ];
  return (
    <dl
      className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded border border-border/60 p-2 text-[11px]"
      data-artifact-diagnostics="true"
    >
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="break-all">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
