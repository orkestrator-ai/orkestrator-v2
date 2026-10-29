import { invoke } from "@/lib/native/backend";
import {
  TRANSCRIPT_ARTIFACT_COMMANDS,
  type ArtifactConversationScope,
  type ArtifactDraftReadRequest,
  type ArtifactDraftSummary,
  type ArtifactLiveSessionResponse,
  type ArtifactPublicationView,
  type ArtifactRepresentationRequest,
  type ArtifactRepresentationResponse,
  type MermaidRenderRequest,
  type MermaidRenderResponse,
  type TranscriptArtifactCapabilities,
  type TranscriptMediaStreamRequest,
  type TranscriptMediaStreamResponse,
  type ArtifactPrepareWorkerResponse,
  type TranscriptMediaPdfPreviewRequest,
  type TranscriptMediaPdfPreviewResponse,
} from "@orkestrator/protocol/transcript-artifact-commands";
import {
  TRANSCRIPT_MEDIA_PIN_COMMAND,
  type TranscriptMediaPinRequest,
  type TranscriptMediaPinResponse,
} from "@orkestrator/protocol/transcript-media-pins";
import type { WorkflowSnapshotV1 } from "@orkestrator/protocol/workflow-snapshot";

export function getTranscriptArtifactCapabilities(): Promise<TranscriptArtifactCapabilities> {
  return invoke(TRANSCRIPT_ARTIFACT_COMMANDS.capabilities);
}

export function getTranscriptArtifactPublication(
  input: ArtifactConversationScope & { publicationId: string },
): Promise<ArtifactPublicationView> {
  return invoke(TRANSCRIPT_ARTIFACT_COMMANDS.getPublication, { ...input });
}

export function listTranscriptArtifactPublications(
  input: ArtifactConversationScope & { afterSequence?: number; limit?: number },
): Promise<{ publications: ArtifactPublicationView[]; nextSequence: number | null }> {
  return invoke(TRANSCRIPT_ARTIFACT_COMMANDS.listPublications, { ...input });
}

export function readTranscriptArtifactRepresentation(
  input: ArtifactRepresentationRequest,
): Promise<ArtifactRepresentationResponse> {
  return invoke(TRANSCRIPT_ARTIFACT_COMMANDS.readRepresentation, { ...input });
}

export function openTranscriptArtifactLiveSession(
  input: ArtifactConversationScope & { publicationId: string },
): Promise<ArtifactLiveSessionResponse> {
  return invoke(TRANSCRIPT_ARTIFACT_COMMANDS.openLiveSession, { ...input });
}

export function closeTranscriptArtifactLiveSession(input: { generation: string }): Promise<void> {
  return invoke(TRANSCRIPT_ARTIFACT_COMMANDS.closeLiveSession, { ...input });
}

export function renderMermaidDiagram(input: MermaidRenderRequest): Promise<MermaidRenderResponse> {
  return invoke(TRANSCRIPT_ARTIFACT_COMMANDS.renderMermaid, { ...input });
}

export type WorkflowLiveSnapshotResponse =
  | { status: "available"; snapshot: WorkflowSnapshotV1; terminal: boolean }
  | {
      status: "unavailable";
      reason: "deleted" | "not_found" | "unsupported" | "error";
      message: string;
    };

export function getWorkflowLiveSnapshot(input: {
  environmentId: string;
  workflowId: string;
  runId: string;
}): Promise<WorkflowLiveSnapshotResponse> {
  return invoke(TRANSCRIPT_ARTIFACT_COMMANDS.workflowLiveSnapshot, { ...input });
}

/**
 * The conversation's artifacts as their author left them, published or not.
 * Owner-scoped like publications: another conversation's drafts are
 * `not_found`.
 */
export function listTranscriptArtifactDrafts(
  input: ArtifactConversationScope,
): Promise<ArtifactDraftSummary[]> {
  return invoke(TRANSCRIPT_ARTIFACT_COMMANDS.listDrafts, { ...input });
}

/** A bounded slice of a draft revision's source, or one failed-preview capture. */
export function readTranscriptArtifactDraft(
  input: ArtifactDraftReadRequest,
): Promise<ArtifactRepresentationResponse> {
  return invoke(TRANSCRIPT_ARTIFACT_COMMANDS.readDraft, { ...input });
}

/**
 * A short-lived, range-capable capability URL on the artifact content origin
 * for one environment media file (backend: `media-stream.ts`). The URL is a
 * bearer secret: use it only as a media element `src`, never log it.
 */
export function openTranscriptMediaStream(
  input: TranscriptMediaStreamRequest,
): Promise<TranscriptMediaStreamResponse> {
  return invoke(TRANSCRIPT_ARTIFACT_COMMANDS.openMediaStream, { ...input });
}

/** Revokes a media stream capability; unknown or already closed ids are ignored. */
export function closeTranscriptMediaStream(input: { streamId: string }): Promise<void> {
  return invoke(TRANSCRIPT_ARTIFACT_COMMANDS.closeMediaStream, { ...input });
}

/**
 * Build (or pull) the isolated container preview worker on the backend and
 * re-select preview isolation. Long-running (bounded by the backend).
 */
export function prepareTranscriptArtifactWorker(): Promise<ArtifactPrepareWorkerResponse> {
  return invoke(TRANSCRIPT_ARTIFACT_COMMANDS.prepareWorker);
}

/** First-page preview of a PDF attachment, read by the backend through its authorized readers. */
export function getTranscriptMediaPdfPreview(
  input: TranscriptMediaPdfPreviewRequest,
): Promise<TranscriptMediaPdfPreviewResponse> {
  return invoke(TRANSCRIPT_ARTIFACT_COMMANDS.mediaPdfPreview, { ...input });
}

/** A local image as the naming message first showed it (saved on first use). */
export function pinTranscriptMedia(
  input: TranscriptMediaPinRequest,
): Promise<TranscriptMediaPinResponse> {
  return invoke(TRANSCRIPT_MEDIA_PIN_COMMAND, { ...input });
}
