import { memo, useMemo, type ReactNode } from "react";
import { toast } from "sonner";
import { ClipboardCopy, Download, FileWarning, RefreshCw } from "lucide-react";
import { readTranscriptArtifactRef } from "@orkestrator/protocol/transcript-artifacts-validation";
import type { TranscriptArtifactRef } from "@orkestrator/protocol/transcript-artifacts";
import type { ArtifactPublicationView } from "@orkestrator/protocol/transcript-artifact-commands";
import type { NativeArtifactPart } from "@/lib/chat/native-message-types";
import {
  richArtifactOccurrenceKey,
  useRichMessageIdentity,
  useRichTranscriptScope,
} from "@/lib/chat/rich-identity";
import { useTranscriptArtifactCapabilities } from "@/hooks/useTranscriptArtifactCapabilities";
import {
  isCurrentArtifactScopeGeneration,
  readWholeRepresentation,
  useArtifactPublication,
  type ArtifactReadScope,
} from "@/lib/chat/artifact-requests";
import { artifactFilename, downloadText } from "@/lib/chat/artifact-download";
import { writeText } from "@/lib/native/clipboard";
import { RichBlockFrame, RichToolbarButton } from "./RichBlockFrame";
import {
  ChartArtifactBody,
  HtmlArtifactBody,
  MermaidArtifactBody,
  WorkflowArtifactBody,
  artifactVerificationLabels,
} from "./ArtifactPartBodies";

/**
 * A published transcript artifact (F10). The part is only a reference; the
 * card resolves it through the authenticated conversation scope:
 *
 *  - unknown versions/kinds and malformed references render an honest
 *    placeholder with the textual summary — never a crash;
 *  - a reference whose provenance names another backend is never treated as
 *    authoritative here and is not fetched;
 *  - storage problems become an artifact-level unavailable state while the
 *    title and summary stay readable;
 *  - responses from a discarded scope generation never populate the card.
 */

const PUBLICATION_ID = /^pub_[A-Za-z0-9_-]{8,64}$/;

export const ArtifactPart = memo(function ArtifactPart({ part }: { part: NativeArtifactPart }) {
  const read = useMemo(() => readTranscriptArtifactRef(part.artifact), [part.artifact]);
  if (read.status === "invalid") {
    return (
      <ArtifactNotice
        title="Artifact"
        summary={part.content}
        kind="invalid"
        message={`This artifact reference could not be read (${read.reason}). Only its text summary is shown.`}
      />
    );
  }
  if (read.status === "unsupported") {
    const publicationId = (part.artifact as { publicationId?: unknown } | undefined)?.publicationId;
    return (
      <ArtifactNotice
        title={read.title}
        summary={read.summary || part.content}
        kind="unsupported"
        message={read.reason}
        sourcePublicationId={
          typeof publicationId === "string" && PUBLICATION_ID.test(publicationId)
            ? publicationId
            : null
        }
      />
    );
  }
  return <SupportedArtifact artifactRef={read.ref} part={part} />;
});

function useAuthorizedScope(
  artifactRef: TranscriptArtifactRef,
):
  | { status: "detached" | "verifying" | "foreign-backend" }
  | { status: "authorized"; scope: ArtifactReadScope & { backendId: string } } {
  const scope = useRichTranscriptScope();
  const capabilities = useTranscriptArtifactCapabilities();
  if (!scope) return { status: "detached" };
  if (!capabilities) return { status: "verifying" };
  // Identity comes from the authenticated connection, never from the reference.
  if (capabilities.backendId !== artifactRef.provenance.backendId)
    return { status: "foreign-backend" };
  return {
    status: "authorized",
    scope: {
      backendId: capabilities.backendId,
      environmentId: scope.environmentId,
      logicalSessionKey: scope.logicalSessionKey,
      generation: scope.generation,
    },
  };
}

function SupportedArtifact({
  artifactRef,
  part,
}: {
  artifactRef: TranscriptArtifactRef;
  part: NativeArtifactPart;
}) {
  const authority = useAuthorizedScope(artifactRef);
  const scope = authority.status === "authorized" ? authority.scope : null;
  const message = useRichMessageIdentity();
  const occurrenceKey = richArtifactOccurrenceKey(
    useRichTranscriptScope(),
    message?.messageId ?? "unknown-message",
    artifactRef.publicationId,
    artifactRef.artifactId,
    artifactRef.revision,
  );
  const publication = useArtifactPublication(scope, scope ? artifactRef.publicationId : null);

  if (authority.status === "detached") {
    return (
      <ArtifactNotice
        title={artifactRef.title}
        summary={artifactRef.summary}
        kind="detached"
        message="Open this artifact from its conversation to view it."
      />
    );
  }
  if (authority.status === "verifying") {
    return (
      <ArtifactNotice
        title={artifactRef.title}
        summary={artifactRef.summary}
        kind="verifying"
        message="Checking the connected backend…"
        loading
      />
    );
  }
  if (authority.status === "foreign-backend") {
    return (
      <ArtifactNotice
        title={artifactRef.title}
        summary={artifactRef.summary}
        kind="foreign-backend"
        message="This artifact was published by a different Orkestrator backend. It is not verified by the connected backend, so only its summary is shown."
      />
    );
  }
  if (publication.status === "loading" || publication.status === "idle") {
    return (
      <ArtifactNotice
        title={artifactRef.title}
        summary={artifactRef.summary}
        kind="loading"
        message="Loading artifact…"
        loading
      />
    );
  }
  if (publication.status === "error") {
    return (
      <ArtifactNotice
        title={artifactRef.title}
        summary={artifactRef.summary}
        kind="error"
        message={
          publication.code === "not_found"
            ? "This artifact is not available in this conversation."
            : "The artifact could not be loaded."
        }
        action={
          publication.code === "not_found" ? undefined : (
            <RichToolbarButton label="Retry" onClick={publication.retry}>
              <RefreshCw aria-hidden="true" />
            </RichToolbarButton>
          )
        }
      />
    );
  }
  const view = publication.value;
  if (
    view.ref.publicationId !== artifactRef.publicationId ||
    view.ref.artifactId !== artifactRef.artifactId ||
    view.ref.revision !== artifactRef.revision ||
    view.ref.kind !== artifactRef.kind
  ) {
    return (
      <ArtifactNotice
        title={artifactRef.title}
        summary={artifactRef.summary}
        kind="mismatch"
        message="The backend returned a different artifact revision than this transcript names, so it is not shown."
      />
    );
  }
  if (view.availability !== "available") {
    return (
      <ArtifactNotice
        title={artifactRef.title}
        summary={artifactRef.summary}
        kind="unavailable"
        revision={artifactRef.revision}
        message={
          view.availability === "missing"
            ? "The stored content of this artifact is missing. The publication record and summary are kept."
            : "The stored content of this artifact failed its integrity check and is not shown."
        }
      />
    );
  }
  return (
    <PublishedArtifact
      artifactRef={artifactRef}
      view={view}
      scope={scope!}
      occurrenceKey={occurrenceKey}
      part={part}
    />
  );
}

function PublishedArtifact({
  artifactRef,
  view,
  scope,
  occurrenceKey,
  part,
}: {
  artifactRef: TranscriptArtifactRef;
  view: ArtifactPublicationView;
  scope: ArtifactReadScope & { backendId: string };
  occurrenceKey: string;
  part: NativeArtifactPart;
}) {
  const labels = artifactVerificationLabels(view);
  let body: ReactNode;
  switch (artifactRef.kind) {
    case "chart":
      body = (
        <ChartArtifactBody artifactRef={artifactRef} scope={scope} occurrenceKey={occurrenceKey} />
      );
      break;
    case "mermaid":
      body = (
        <MermaidArtifactBody
          artifactRef={artifactRef}
          scope={scope}
          occurrenceKey={occurrenceKey}
        />
      );
      break;
    case "workflow-snapshot":
      body = (
        <WorkflowArtifactBody
          artifactRef={artifactRef}
          scope={scope}
          occurrenceKey={occurrenceKey}
        />
      );
      break;
    case "html-static":
    case "html-interactive":
      body = (
        <HtmlArtifactBody
          artifactRef={artifactRef}
          view={view}
          scope={scope}
          occurrenceKey={occurrenceKey}
        />
      );
      break;
  }
  return (
    <RichBlockFrame
      kind="artifact"
      blockKey={occurrenceKey}
      title={artifactRef.title}
      subtitle={`Revision ${artifactRef.revision}`}
      status={
        <span className="flex items-center gap-1.5" data-artifact-verification="true">
          <span>{labels.profile}</span>
          {labels.semantics ? <span>· {labels.semantics}</span> : null}
        </span>
      }
      actions={<CopySourceButton artifactRef={artifactRef} scope={scope} />}
      ariaLabel={`Artifact: ${artifactRef.title}`}
    >
      <div
        data-artifact-part={artifactRef.kind}
        data-artifact-publication={artifactRef.publicationId}
      >
        {artifactRef.summary ? (
          <p
            className="px-3 pt-2 text-xs text-foreground/90"
            data-artifact-summary="true"
            data-agent-chat-search-content="true"
          >
            {artifactRef.summary}
          </p>
        ) : null}
        <span className="sr-only">{part.content}</span>
        {body}
      </div>
    </RichBlockFrame>
  );
}

function CopySourceButton({
  artifactRef,
  scope,
}: {
  artifactRef: TranscriptArtifactRef;
  scope: ArtifactReadScope;
}) {
  if (artifactRef.kind === "workflow-snapshot") return null;
  return (
    <RichToolbarButton
      label="Copy source"
      onClick={() => {
        void readWholeRepresentation(scope, artifactRef.publicationId, "source")
          .then(async (response) => {
            if (!isCurrentArtifactScopeGeneration(scope)) return;
            if (response.encoding !== "utf8") throw new Error("not text");
            await writeText(response.data);
            toast.success("Copied source");
          })
          .catch(() =>
            toast.error("Could not copy the source", {
              description: "Use Download source instead.",
            }),
          );
      }}
    >
      <ClipboardCopy aria-hidden="true" />
    </RichToolbarButton>
  );
}

const NOTICE_KIND_LABEL: Record<string, string> = {
  invalid: "Unreadable reference",
  unsupported: "Unsupported artifact",
  detached: "Artifact",
  verifying: "Artifact",
  "foreign-backend": "Not verified here",
  loading: "Artifact",
  error: "Unavailable",
  mismatch: "Revision mismatch",
  unavailable: "Content unavailable",
};

/** Title, summary and an honest message; never the artifact body. */
export function ArtifactNotice({
  title,
  summary,
  kind,
  message,
  loading,
  action,
  revision,
  sourcePublicationId,
}: {
  title: string;
  summary: string;
  kind: string;
  message: string;
  loading?: boolean;
  action?: ReactNode;
  revision?: number;
  sourcePublicationId?: string | null;
}) {
  const scope = useRichTranscriptScope();
  const capabilities = useTranscriptArtifactCapabilities();
  return (
    <RichBlockFrame
      kind="artifact"
      title={title || "Artifact"}
      subtitle={revision !== undefined ? `Revision ${revision}` : undefined}
      status={NOTICE_KIND_LABEL[kind] ?? "Artifact"}
      loading={loading}
      loadingLabel={message}
      ariaLabel={`Artifact: ${title || "Artifact"}`}
      actions={
        <>
          {action}
          <RichToolbarButton
            label="Copy summary"
            onClick={() => {
              void writeText([title, summary].filter(Boolean).join("\n")).catch(() =>
                toast.error("Clipboard is unavailable"),
              );
            }}
          >
            <ClipboardCopy aria-hidden="true" />
          </RichToolbarButton>
          {sourcePublicationId && scope && capabilities ? (
            <RichToolbarButton
              label="Download source"
              onClick={() => {
                const readScope = { ...scope, backendId: capabilities.backendId };
                void readWholeRepresentation(readScope, sourcePublicationId, "source")
                  .then((response) => {
                    if (response.encoding !== "utf8") throw new Error("not text");
                    downloadText(
                      response.data,
                      artifactFilename(title, "txt"),
                      "text/plain;charset=utf-8",
                    );
                  })
                  .catch(() => toast.error("The source is not available for this artifact"));
              }}
            >
              <Download aria-hidden="true" />
            </RichToolbarButton>
          ) : null}
        </>
      }
    >
      <div className="px-3 py-2 text-xs" data-artifact-notice={kind}>
        {summary ? (
          <p
            className="text-foreground/90"
            data-artifact-summary="true"
            data-agent-chat-search-content="true"
          >
            {summary}
          </p>
        ) : null}
        {!loading ? (
          <p className="mt-1 flex items-start gap-1.5 text-muted-foreground">
            <FileWarning aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            <span>{message}</span>
          </p>
        ) : null}
      </div>
    </RichBlockFrame>
  );
}
