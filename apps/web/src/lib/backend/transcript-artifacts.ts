import type { WorkflowLiveSnapshotResponse } from "@orkestrator/protocol/contract/domains/transcripts";
import type {
  ArtifactConversationScope,
  ArtifactDraftReadRequest,
  ArtifactDraftSummary,
  ArtifactLiveSessionResponse,
  ArtifactPublicationView,
  ArtifactRepresentationRequest,
  ArtifactRepresentationResponse,
  MermaidRenderRequest,
  MermaidRenderResponse,
  TranscriptArtifactCapabilities,
  TranscriptMediaStreamRequest,
  TranscriptMediaStreamResponse,
  ArtifactPrepareWorkerResponse,
  TranscriptMediaPdfPreviewRequest,
  TranscriptMediaPdfPreviewResponse,
} from "@orkestrator/protocol/transcript-artifact-commands";
import type {
  TranscriptMediaPinRequest,
  TranscriptMediaPinResponse,
} from "@orkestrator/protocol/transcript-media-pins";
import { commandBackendClient, type BackendClient } from "./client";
import { transcripts } from "@/lib/node-scope/domains/transcripts";

/** The `transcripts` domain's schema type (plan item 7004). */
export type { WorkflowLiveSnapshotResponse };

/**
 * This file's commands on `client`'s node (plan item 3002), through the
 * `transcripts` domain client (plan item 7004). A scoped store or service
 * passes its own node's client; the named exports below are this over the
 * window's command scope.
 */
export function createTranscriptArtifactsApi(client: BackendClient) {
  const artifacts = transcripts(client);

  function getTranscriptArtifactCapabilities(): Promise<TranscriptArtifactCapabilities> {
    return artifacts().artifactCapabilities({});
  }

  function getTranscriptArtifactPublication(
    input: ArtifactConversationScope & { publicationId: string },
  ): Promise<ArtifactPublicationView> {
    return artifacts().getPublication({ ...input });
  }

  async function listTranscriptArtifactPublications(
    input: ArtifactConversationScope & { afterSequence?: number; limit?: number },
  ): Promise<{ publications: ArtifactPublicationView[]; nextSequence: number | null }> {
    const page = await artifacts().listPublications({ ...input });
    return { publications: [...page.publications], nextSequence: page.nextSequence };
  }

  function readTranscriptArtifactRepresentation(
    input: ArtifactRepresentationRequest,
  ): Promise<ArtifactRepresentationResponse> {
    return artifacts().readRepresentation({ ...input });
  }

  function openTranscriptArtifactLiveSession(
    input: ArtifactConversationScope & { publicationId: string },
  ): Promise<ArtifactLiveSessionResponse> {
    return artifacts().openLiveSession({ ...input });
  }

  async function closeTranscriptArtifactLiveSession(input: { generation: string }): Promise<void> {
    await artifacts().closeLiveSession({ ...input });
  }

  function renderMermaidDiagram(input: MermaidRenderRequest): Promise<MermaidRenderResponse> {
    return artifacts().renderMermaid({ ...input });
  }

  function getWorkflowLiveSnapshot(input: {
    environmentId: string;
    workflowId: string;
    runId: string;
  }): Promise<WorkflowLiveSnapshotResponse> {
    return artifacts().workflowLiveSnapshot({ ...input });
  }

  /**
   * The conversation's artifacts as their author left them, published or not.
   * Owner-scoped like publications: another conversation's drafts are
   * `not_found`. The backend answers `{ drafts }`; this unwraps it (the
   * renderer read the answer as an array before the typed result, so it
   * always listed nothing).
   */
  async function listTranscriptArtifactDrafts(
    input: ArtifactConversationScope,
  ): Promise<ArtifactDraftSummary[]> {
    const answer: unknown = await artifacts().listDrafts({ ...input });
    if (Array.isArray(answer)) return answer as ArtifactDraftSummary[];
    const drafts = (answer as { drafts?: unknown } | null)?.drafts;
    return Array.isArray(drafts) ? (drafts as ArtifactDraftSummary[]) : [];
  }

  /** A bounded slice of a draft revision's source, or one failed-preview capture. */
  function readTranscriptArtifactDraft(
    input: ArtifactDraftReadRequest,
  ): Promise<ArtifactRepresentationResponse> {
    return artifacts().readDraft({ ...input });
  }

  /**
   * A short-lived, range-capable capability URL on the artifact content origin
   * for one environment media file (backend: `media-stream.ts`). The URL is a
   * bearer secret: use it only as a media element `src`, never log it.
   */
  function openTranscriptMediaStream(
    input: TranscriptMediaStreamRequest,
  ): Promise<TranscriptMediaStreamResponse> {
    return artifacts().openMediaStream({ ...input });
  }

  /** Revokes a media stream capability; unknown or already closed ids are ignored. */
  async function closeTranscriptMediaStream(input: { streamId: string }): Promise<void> {
    await artifacts().closeMediaStream({ ...input });
  }

  /**
   * Build (or pull) the isolated container preview worker on the backend and
   * re-select preview isolation. Long-running (bounded by the backend).
   */
  function prepareTranscriptArtifactWorker(): Promise<ArtifactPrepareWorkerResponse> {
    return artifacts().prepareWorker({});
  }

  /** First-page preview of a PDF attachment, read by the backend through its authorized readers. */
  function getTranscriptMediaPdfPreview(
    input: TranscriptMediaPdfPreviewRequest,
  ): Promise<TranscriptMediaPdfPreviewResponse> {
    return artifacts().mediaPdfPreview({ ...input });
  }

  /** A local image as the naming message first showed it (saved on first use). */
  function pinTranscriptMedia(
    input: TranscriptMediaPinRequest,
  ): Promise<TranscriptMediaPinResponse> {
    return artifacts().pinMedia({ ...input });
  }

  return {
    getTranscriptArtifactCapabilities,
    getTranscriptArtifactPublication,
    listTranscriptArtifactPublications,
    readTranscriptArtifactRepresentation,
    openTranscriptArtifactLiveSession,
    closeTranscriptArtifactLiveSession,
    renderMermaidDiagram,
    getWorkflowLiveSnapshot,
    listTranscriptArtifactDrafts,
    readTranscriptArtifactDraft,
    openTranscriptMediaStream,
    closeTranscriptMediaStream,
    prepareTranscriptArtifactWorker,
    getTranscriptMediaPdfPreview,
    pinTranscriptMedia,
  };
}

export type TranscriptArtifactsApi = ReturnType<typeof createTranscriptArtifactsApi>;

/** The window's command-scope binding (the counted shim, plan item 3002). */
export const {
  getTranscriptArtifactCapabilities,
  getTranscriptArtifactPublication,
  listTranscriptArtifactPublications,
  readTranscriptArtifactRepresentation,
  openTranscriptArtifactLiveSession,
  closeTranscriptArtifactLiveSession,
  renderMermaidDiagram,
  getWorkflowLiveSnapshot,
  listTranscriptArtifactDrafts,
  readTranscriptArtifactDraft,
  openTranscriptMediaStream,
  closeTranscriptMediaStream,
  prepareTranscriptArtifactWorker,
  getTranscriptMediaPdfPreview,
  pinTranscriptMedia,
} = createTranscriptArtifactsApi(commandBackendClient);
