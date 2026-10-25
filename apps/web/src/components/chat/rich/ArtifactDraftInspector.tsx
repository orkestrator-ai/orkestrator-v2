import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ClipboardCopy, FileSearch, RefreshCw } from "lucide-react";
import {
  ARTIFACT_TOOL_NAMES,
  orkestratorToolName,
  type ArtifactToolName,
} from "@orkestrator/protocol/transcript-artifacts";
import type {
  ArtifactConversationScope,
  ArtifactDraftSummary,
  ArtifactRepresentationResponse,
} from "@orkestrator/protocol/transcript-artifact-commands";
import {
  listTranscriptArtifactDrafts,
  readTranscriptArtifactDraft,
} from "@/lib/backend/transcript-artifacts";
import { artifactErrorInfo, MAX_TEXT_REPRESENTATION_BYTES } from "@/lib/chat/artifact-requests";
import { useRichTranscriptScope } from "@/lib/chat/rich-identity";
import { writeText } from "@/lib/native/clipboard";
import { onResourceChanged } from "@/lib/resource-sync";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { ArtifactWorkerPrepareAction } from "./ArtifactWorkerPrepareAction";

/**
 * Host-owned inspection of a conversation's artifact drafts (spec: "A user
 * must still be able to inspect/copy draft source when rendering fails").
 *
 * Opened from the tool row of a canonical authoring tool. Everything shown
 * is read through the owner-scoped draft commands: the exact revision source
 * in bounded slices, the latest verification operation's status and
 * diagnostics, and failed-preview diagnostic captures as images. Nothing
 * here publishes, previews or executes a draft; the content is always
 * labelled "Draft — not published" unless that exact revision is published.
 */

/** Authoring tools whose rows offer "Inspect draft". */
export const DRAFT_INSPECTABLE_TOOLS = [
  "create_artifact",
  "update_artifact",
  "preview_artifact",
  "get_artifact_operation",
] as const satisfies readonly ArtifactToolName[];

export type DraftInspectableTool = (typeof DRAFT_INSPECTABLE_TOOLS)[number];

/** Source bytes requested per displayed slice. */
export const DRAFT_SOURCE_SLICE_BYTES = 64 * 1024;
/** Display bound: "Load more" stops here; Copy source reads up to MAX_TEXT_REPRESENTATION_BYTES. */
export const MAX_DRAFT_SOURCE_DISPLAY_BYTES = 1024 * 1024;
/** Diagnostic captures shown per operation. */
export const MAX_DRAFT_CAPTURES_SHOWN = 4;

const ARTIFACT_ID = /^art_[A-Za-z0-9_-]{8,64}$/;
const ARTIFACT_ID_IN_TEXT = /"artifactId"\s*:\s*"(art_[A-Za-z0-9_-]{8,64})"/;
const CAPTURE_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);

export function draftInspectorTool(
  toolName: string | undefined,
  options: { toolTitle?: string; mcpServerName?: string },
): DraftInspectableTool | null {
  const tool = orkestratorToolName(toolName, ARTIFACT_TOOL_NAMES, options);
  return tool && (DRAFT_INSPECTABLE_TOOLS as readonly string[]).includes(tool)
    ? (tool as DraftInspectableTool)
    : null;
}

/**
 * Which artifact the row is about, to preselect it. A hint only: the list
 * comes from the backend and an unknown id simply selects nothing special.
 */
export function draftArtifactIdHint(
  toolArgs: Record<string, unknown> | undefined,
  toolOutput: string | undefined,
): string | null {
  const fromArgs = toolArgs?.artifactId;
  if (typeof fromArgs === "string" && ARTIFACT_ID.test(fromArgs)) return fromArgs;
  const match = toolOutput ? ARTIFACT_ID_IN_TEXT.exec(toolOutput.slice(0, 16_384)) : null;
  return match?.[1] ?? null;
}

/**
 * The tool-row action. Rendered beside (never inside) the row's disclosure
 * trigger so no button is nested in another.
 */
export function ArtifactDraftInspectorAction({
  toolName,
  toolTitle,
  mcpServerName,
  toolArgs,
  toolOutput,
}: {
  toolName?: string;
  toolTitle?: string;
  mcpServerName?: string;
  toolArgs?: Record<string, unknown>;
  toolOutput?: string;
}) {
  const scope = useRichTranscriptScope();
  const [open, setOpen] = useState(false);
  const tool = useMemo(
    () => draftInspectorTool(toolName, { toolTitle, mcpServerName }),
    [mcpServerName, toolName, toolTitle],
  );
  if (!tool || !scope) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Inspect draft"
        title="Inspect the artifact draft: source, verification diagnostics and failed-preview captures"
        data-artifact-draft-inspect="true"
        className="inline-flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[11px] text-muted-foreground outline-none hover:bg-elevated hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <FileSearch aria-hidden="true" className="size-3" />
        Inspect draft
      </button>
      {open ? (
        <ArtifactDraftInspectorDialog
          scope={{
            environmentId: scope.environmentId,
            logicalSessionKey: scope.logicalSessionKey,
          }}
          initialArtifactId={draftArtifactIdHint(toolArgs, toolOutput)}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

type ListResult =
  | { request: number; status: "ready"; drafts: ArtifactDraftSummary[] }
  | { request: number; status: "error"; message: string; code?: string };

export function ArtifactDraftInspectorDialog({
  scope,
  initialArtifactId,
  onClose,
}: {
  scope: ArtifactConversationScope;
  initialArtifactId: string | null;
  onClose: () => void;
}) {
  const { environmentId, logicalSessionKey } = scope;
  const [request, setRequest] = useState(0);
  const [result, setResult] = useState<ListResult | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(initialArtifactId);

  useEffect(() => {
    let cancelled = false;
    listTranscriptArtifactDrafts({ environmentId, logicalSessionKey })
      .then((drafts) => {
        if (!cancelled)
          setResult({
            request,
            status: "ready",
            drafts: Array.isArray(drafts) ? drafts : [],
          });
      })
      .catch((error: unknown) => {
        if (!cancelled) setResult({ request, status: "error", ...artifactErrorInfo(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [environmentId, logicalSessionKey, request]);

  // Drafts change while the dialog is open (a new revision, a finished preview).
  useEffect(
    () =>
      onResourceChanged("transcript-artifact", (change) => {
        if (change.id === logicalSessionKey) setRequest((value) => value + 1);
      }),
    [logicalSessionKey],
  );

  const drafts = result?.status === "ready" ? result.drafts : [];
  // The row's artifact when the list has it, else the first draft.
  const selected = drafts.find((draft) => draft.artifactId === selectedId) ?? drafts[0] ?? null;

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-5xl" data-artifact-draft-inspector="true">
        <DialogTitle>Inspect artifact drafts</DialogTitle>
        <DialogDescription>
          Artifacts in this conversation as the agent left them. Drafts are not published: they are
          shown here for inspection only and are never run.
        </DialogDescription>
        {!result || (result.request !== request && result.status === "error") ? (
          <p className="text-xs text-muted-foreground" aria-live="polite">
            Loading drafts…
          </p>
        ) : result.status === "error" ? (
          <p role="alert" className="flex items-center gap-2 text-xs text-muted-foreground">
            {result.code === "not_found"
              ? "No drafts are available for this conversation."
              : `Drafts could not be loaded: ${result.message}`}
            <button
              type="button"
              className="inline-flex items-center gap-1 underline"
              onClick={() => setRequest((value) => value + 1)}
            >
              <RefreshCw aria-hidden="true" className="size-3" /> Retry
            </button>
          </p>
        ) : drafts.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            This conversation has no artifact drafts yet.
          </p>
        ) : (
          <div className="grid min-h-0 gap-3 md:grid-cols-[14rem_minmax(0,1fr)]">
            <ul aria-label="Artifacts" className="flex flex-col gap-1 text-xs">
              {drafts.map((draft) => {
                const current = selected?.artifactId === draft.artifactId;
                return (
                  <li key={draft.artifactId}>
                    <button
                      type="button"
                      aria-current={current ? "true" : undefined}
                      onClick={() => setSelectedId(draft.artifactId)}
                      className={cn(
                        "flex w-full flex-col items-start rounded border border-border px-2 py-1.5 text-left outline-none hover:bg-elevated focus-visible:ring-2 focus-visible:ring-ring/60",
                        current && "bg-elevated",
                      )}
                    >
                      <span className="w-full truncate font-medium">{draft.title}</span>
                      <span className="text-muted-foreground">
                        {draft.kind} · revision {draft.currentRevision}
                        {draft.publishedRevision === draft.currentRevision
                          ? " · published"
                          : " · draft"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {selected ? (
              <DraftDetails key={selected.artifactId} scope={scope} draft={selected} />
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DraftDetails({
  scope,
  draft,
}: {
  scope: ArtifactConversationScope;
  draft: ArtifactDraftSummary;
}) {
  const published = draft.publishedRevision === draft.currentRevision;
  return (
    <section
      aria-label={`Draft ${draft.title}`}
      className="flex min-w-0 flex-col gap-3 text-xs"
      data-artifact-draft={draft.artifactId}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">{draft.title}</h3>
        <span
          data-artifact-draft-label="true"
          className={cn(
            "rounded border px-1.5 py-0.5 font-medium",
            published ? "border-border text-muted-foreground" : "border-yellow-600 text-yellow-600",
          )}
        >
          {published
            ? `Revision ${draft.currentRevision} — published`
            : `Draft — not published (revision ${draft.currentRevision})`}
        </span>
        {!published && draft.publishedRevision !== null ? (
          <span className="text-muted-foreground">
            Revision {draft.publishedRevision} is the published one.
          </span>
        ) : null}
      </div>
      {draft.summary ? <p className="text-muted-foreground">{draft.summary}</p> : null}
      <DraftOperation scope={scope} draft={draft} />
      <DraftSource
        key={draft.currentRevision}
        scope={scope}
        artifactId={draft.artifactId}
        revision={draft.currentRevision}
      />
    </section>
  );
}

const STATUS_TEXT: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};

function DraftOperation({
  scope,
  draft,
}: {
  scope: ArtifactConversationScope;
  draft: ArtifactDraftSummary;
}) {
  const operation = draft.latestOperation;
  if (!operation) {
    return (
      <p className="text-muted-foreground" data-artifact-draft-operation="none">
        No verification has been run for this revision.
      </p>
    );
  }
  const captures = Math.min(operation.diagnosticCaptureCount, MAX_DRAFT_CAPTURES_SHOWN);
  return (
    <div
      className="flex flex-col gap-2 rounded border border-border/60 p-2"
      data-artifact-draft-operation={operation.status}
    >
      <p>
        <span className="font-medium">
          Latest verification: {STATUS_TEXT[operation.status] ?? operation.status}
        </span>
        <span className="text-muted-foreground">
          {" "}
          · revision {operation.revision}
          {operation.revision !== draft.currentRevision ? " (not the current revision)" : ""} ·
          semantics {operation.semantics.replaceAll("-", " ")} · {operation.operationId}
        </span>
      </p>
      {operation.error ? (
        <p className="text-failure" data-artifact-draft-error={operation.error.code}>
          <span className="font-mono">{operation.error.code}</span>: {operation.error.message}
        </p>
      ) : null}
      {operation.error?.code === "renderer_unavailable" && draft.kind === "html-interactive" ? (
        <ArtifactWorkerPrepareAction />
      ) : null}
      {operation.diagnostics.length > 0 ? (
        <table className="w-full table-fixed border-collapse text-left">
          <caption className="sr-only">Diagnostics</caption>
          <thead className="text-muted-foreground">
            <tr>
              <th scope="col" className="w-16 font-normal">
                Severity
              </th>
              <th scope="col" className="w-40 font-normal">
                Code
              </th>
              <th scope="col" className="w-28 font-normal">
                Location
              </th>
              <th scope="col" className="font-normal">
                Message
              </th>
            </tr>
          </thead>
          <tbody>
            {operation.diagnostics.map((diagnostic, index) => (
              <tr key={index} className="align-top" data-artifact-diagnostic={diagnostic.code}>
                <td>{diagnostic.severity}</td>
                <td className="break-all font-mono">{diagnostic.code}</td>
                <td className="break-all font-mono">{diagnostic.location ?? "—"}</td>
                <td className="break-words">{diagnostic.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-muted-foreground">No diagnostics were recorded.</p>
      )}
      {operation.omittedDiagnostics > 0 ? (
        <p className="text-muted-foreground">
          {operation.omittedDiagnostics} more diagnostic
          {operation.omittedDiagnostics === 1 ? " was" : "s were"} omitted by the backend.
        </p>
      ) : null}
      {captures > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground">
            Failed-preview captures (diagnostic evidence, not a verified preview)
            {operation.diagnosticCaptureCount > captures
              ? ` — showing ${captures} of ${operation.diagnosticCaptureCount}`
              : ""}
            :
          </p>
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: captures }, (_, index) => (
              <DraftCapture
                key={index}
                scope={scope}
                artifactId={draft.artifactId}
                revision={operation.revision}
                operationId={operation.operationId}
                captureIndex={index}
                title={draft.title}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

type CaptureState =
  | { status: "loading" }
  | { status: "ready"; url: string; width?: number; height?: number }
  | { status: "error"; message: string };

function DraftCapture({
  scope,
  artifactId,
  revision,
  operationId,
  captureIndex,
  title,
}: {
  scope: ArtifactConversationScope;
  artifactId: string;
  revision: number;
  operationId: string;
  captureIndex: number;
  title: string;
}) {
  const [state, setState] = useState<CaptureState>({ status: "loading" });
  const { environmentId, logicalSessionKey } = scope;
  useEffect(() => {
    let cancelled = false;
    readTranscriptArtifactDraft({
      environmentId,
      logicalSessionKey,
      artifactId,
      revision,
      representation: "diagnostic-capture",
      operationId,
      captureIndex,
    })
      .then((response) => {
        if (cancelled) return;
        if (
          response.artifactId !== artifactId ||
          response.revision !== revision ||
          response.encoding !== "base64" ||
          !CAPTURE_MIME.has(response.mimeType)
        ) {
          setState({
            status: "error",
            message: "The capture is not a displayable image.",
          });
          return;
        }
        setState({
          status: "ready",
          url: `data:${response.mimeType};base64,${response.data}`,
        });
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setState({
            status: "error",
            message: artifactErrorInfo(error).message,
          });
      });
    return () => {
      cancelled = true;
    };
  }, [artifactId, captureIndex, environmentId, logicalSessionKey, operationId, revision]);

  if (state.status === "loading") {
    return (
      <div className="flex h-24 w-40 items-center justify-center rounded border border-dashed border-border text-muted-foreground">
        Loading capture {captureIndex + 1}…
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="w-40 rounded border border-dashed border-border p-2 text-muted-foreground">
        Capture {captureIndex + 1} is unavailable: {state.message}
      </div>
    );
  }
  return (
    <img
      src={state.url}
      alt={`Failed-preview capture ${captureIndex + 1} of ${title}, revision ${revision}`}
      data-artifact-draft-capture={captureIndex}
      className="h-auto max-h-80 max-w-full rounded border border-border"
    />
  );
}

interface SourceState {
  text: string;
  bytes: number;
  totalBytes: number;
  nextOffsetBytes: number | null;
  sha256: string;
}

type SourceResult =
  | { status: "loading" }
  | {
      status: "ready";
      source: SourceState;
      loadingMore: boolean;
      moreError?: string;
    }
  | { status: "error"; message: string; code?: string };

function sliceOf(
  scope: ArtifactConversationScope,
  artifactId: string,
  revision: number,
  offsetBytes: number,
  limitBytes: number,
): Promise<ArtifactRepresentationResponse> {
  return readTranscriptArtifactDraft({
    environmentId: scope.environmentId,
    logicalSessionKey: scope.logicalSessionKey,
    artifactId,
    revision,
    representation: "source",
    sourceRange: { offsetBytes, limitBytes },
  });
}

function checkSlice(
  response: ArtifactRepresentationResponse,
  artifactId: string,
  revision: number,
  sha256?: string,
): void {
  if (response.artifactId !== artifactId || response.revision !== revision) {
    throw new Error("The backend returned a different revision than requested.");
  }
  if (response.encoding !== "utf8") throw new Error("The source is not text.");
  if (sha256 !== undefined && response.sha256 !== sha256) {
    throw new Error("The source changed while it was being read.");
  }
}

/** Read the exact revision source, all of it, within the copy bound. */
export async function readWholeDraftSource(
  scope: ArtifactConversationScope,
  artifactId: string,
  revision: number,
): Promise<string> {
  const first = await sliceOf(scope, artifactId, revision, 0, 256 * 1024);
  checkSlice(first, artifactId, revision);
  let text = first.data;
  let bytes = first.byteLength;
  let next = first.nextOffsetBytes;
  while (next !== null) {
    if (bytes >= MAX_TEXT_REPRESENTATION_BYTES) {
      throw new Error(
        `The source is larger than ${MAX_TEXT_REPRESENTATION_BYTES / (1024 * 1024)} MiB and cannot be copied whole.`,
      );
    }
    const page = await sliceOf(
      scope,
      artifactId,
      revision,
      next,
      Math.min(256 * 1024, MAX_TEXT_REPRESENTATION_BYTES - bytes),
    );
    checkSlice(page, artifactId, revision, first.sha256);
    text += page.data;
    bytes += page.byteLength;
    next = page.nextOffsetBytes;
  }
  return text;
}

function DraftSource({
  scope,
  artifactId,
  revision,
}: {
  scope: ArtifactConversationScope;
  artifactId: string;
  revision: number;
}) {
  const [result, setResult] = useState<SourceResult>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const scopeRef = useRef(scope);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const { environmentId, logicalSessionKey } = scope;

  useEffect(() => {
    scopeRef.current = { environmentId, logicalSessionKey };
    let cancelled = false;
    sliceOf({ environmentId, logicalSessionKey }, artifactId, revision, 0, DRAFT_SOURCE_SLICE_BYTES)
      .then((response) => {
        if (cancelled) return;
        checkSlice(response, artifactId, revision);
        setResult({
          status: "ready",
          loadingMore: false,
          source: {
            text: response.data,
            bytes: response.byteLength,
            totalBytes: response.totalBytes,
            nextOffsetBytes: response.nextOffsetBytes,
            sha256: response.sha256,
          },
        });
      })
      .catch((error: unknown) => {
        if (!cancelled) setResult({ status: "error", ...artifactErrorInfo(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [artifactId, attempt, environmentId, logicalSessionKey, revision]);

  const loadMore = useCallback(() => {
    if (result.status !== "ready" || result.loadingMore) return;
    const { source } = result;
    if (source.nextOffsetBytes === null) return;
    setResult({ ...result, loadingMore: true, moreError: undefined });
    sliceOf(
      scopeRef.current,
      artifactId,
      revision,
      source.nextOffsetBytes,
      DRAFT_SOURCE_SLICE_BYTES,
    )
      .then((page) => {
        if (!mounted.current) return;
        checkSlice(page, artifactId, revision, source.sha256);
        setResult({
          status: "ready",
          loadingMore: false,
          source: {
            ...source,
            text: source.text + page.data,
            bytes: source.bytes + page.byteLength,
            nextOffsetBytes: page.nextOffsetBytes,
          },
        });
      })
      .catch((error: unknown) => {
        if (!mounted.current) return;
        setResult({
          status: "ready",
          loadingMore: false,
          source,
          moreError: error instanceof Error ? error.message : artifactErrorInfo(error).message,
        });
      });
  }, [artifactId, result, revision]);

  const copy = () => {
    void readWholeDraftSource(scopeRef.current, artifactId, revision)
      .then(async (text) => {
        await writeText(text);
        toast.success("Copied draft source");
      })
      .catch((error: unknown) =>
        toast.error("Could not copy the draft source", {
          description: error instanceof Error ? error.message : undefined,
        }),
      );
  };

  return (
    <div className="flex min-w-0 flex-col gap-1" data-artifact-draft-source-panel="true">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Source · revision {revision}</span>
        <button
          type="button"
          onClick={copy}
          disabled={result.status !== "ready"}
          className="inline-flex h-6 items-center gap-1 rounded border border-border px-1.5 outline-none hover:bg-elevated focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50"
        >
          <ClipboardCopy aria-hidden="true" className="size-3" />
          Copy source
        </button>
      </div>
      {result.status === "loading" ? (
        <p className="text-muted-foreground" aria-live="polite">
          Loading source…
        </p>
      ) : result.status === "error" ? (
        <p role="alert" className="flex items-center gap-2 text-muted-foreground">
          {result.code === "not_found"
            ? "The source of this revision is not available."
            : `The source could not be loaded: ${result.message}`}
          <button
            type="button"
            className="inline-flex items-center gap-1 underline"
            onClick={() => {
              setResult({ status: "loading" });
              setAttempt((value) => value + 1);
            }}
          >
            <RefreshCw aria-hidden="true" className="size-3" /> Retry
          </button>
        </p>
      ) : (
        <>
          <pre
            data-artifact-draft-source="true"
            className="max-h-[50vh] overflow-auto whitespace-pre rounded border border-border/60 p-2 font-mono text-[11px]"
          >
            <code>{result.source.text}</code>
          </pre>
          <p className="flex flex-wrap items-center gap-2 text-muted-foreground">
            <span>
              Showing {result.source.bytes.toLocaleString("en-US")} of{" "}
              {result.source.totalBytes.toLocaleString("en-US")} bytes · sha256{" "}
              {result.source.sha256.slice(0, 12)}
            </span>
            {result.source.nextOffsetBytes !== null ? (
              result.source.bytes < MAX_DRAFT_SOURCE_DISPLAY_BYTES ? (
                <button
                  type="button"
                  className="underline disabled:opacity-50"
                  onClick={loadMore}
                  disabled={result.loadingMore}
                >
                  {result.loadingMore ? "Loading…" : "Load more"}
                </button>
              ) : (
                <span>Display limit reached; use Copy source for the rest.</span>
              )
            ) : null}
            {result.moreError ? <span role="alert">{result.moreError}</span> : null}
          </p>
        </>
      )}
    </div>
  );
}
