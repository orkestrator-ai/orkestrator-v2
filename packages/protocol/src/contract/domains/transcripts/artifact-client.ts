/**
 * The transcript artifact and media part of the `transcripts` domain client
 * (plan item 7004; `./client.ts` composes it with plan item 7001's part).
 *
 * These commands were never gated by version: callers read
 * `transcript_artifact_capabilities` for runtime state (authoring, the
 * preview renderer's isolation, rollout flags, the content origin), and an
 * older backend's missing command answers `unknown-command`. So both
 * adapters offer the same calls:
 *
 * - **Version 1** sends the envelope (the critical `containerId` of the media
 *   reads) and decodes each result with its command's schema.
 * - **Version 0**, for a pre-contract node, is today's call by name without
 *   an envelope, its answer not decoded, so an older backend's shapes are
 *   taken as they always were.
 *
 * `transcript_artifact_capabilities` stays registered and is read on every
 * version, because it reports runtime state rather than support.
 *
 * Browser-safe.
 */
import type { CommandCall, DomainAdapterContext } from "../../client.js";
import type { AnyCommandDef, ArgsOf, ResultOf } from "../../command.js";
import {
  transcriptArtifactCapabilitiesCommand,
  transcriptArtifactCloseLiveSessionCommand,
  transcriptArtifactGetPublicationCommand,
  transcriptArtifactListDraftsCommand,
  transcriptArtifactListPublicationsCommand,
  transcriptArtifactOpenLiveSessionCommand,
  transcriptArtifactPrepareWorkerCommand,
  transcriptArtifactReadDraftCommand,
  transcriptArtifactReadRepresentationCommand,
  transcriptArtifactRenderMermaidCommand,
  transcriptArtifactStageAssetCommand,
  transcriptArtifactWorkflowLiveSnapshotCommand,
  transcriptMediaCloseStreamCommand,
  transcriptMediaOpenStreamCommand,
  transcriptMediaPdfPreviewCommand,
  transcriptMediaPinCommand,
} from "./artifact-commands.js";

type Call<C extends AnyCommandDef> = (args: ArgsOf<C>) => Promise<ResultOf<C>>;

/** One method per transcript artifact or media command. */
export interface TranscriptArtifactsApi {
  artifactCapabilities: Call<typeof transcriptArtifactCapabilitiesCommand>;
  getPublication: Call<typeof transcriptArtifactGetPublicationCommand>;
  listPublications: Call<typeof transcriptArtifactListPublicationsCommand>;
  readRepresentation: Call<typeof transcriptArtifactReadRepresentationCommand>;
  openLiveSession: Call<typeof transcriptArtifactOpenLiveSessionCommand>;
  closeLiveSession: Call<typeof transcriptArtifactCloseLiveSessionCommand>;
  renderMermaid: Call<typeof transcriptArtifactRenderMermaidCommand>;
  workflowLiveSnapshot: Call<typeof transcriptArtifactWorkflowLiveSnapshotCommand>;
  listDrafts: Call<typeof transcriptArtifactListDraftsCommand>;
  readDraft: Call<typeof transcriptArtifactReadDraftCommand>;
  stageAsset: Call<typeof transcriptArtifactStageAssetCommand>;
  openMediaStream: Call<typeof transcriptMediaOpenStreamCommand>;
  closeMediaStream: Call<typeof transcriptMediaCloseStreamCommand>;
  mediaPdfPreview: Call<typeof transcriptMediaPdfPreviewCommand>;
  prepareWorker: Call<typeof transcriptArtifactPrepareWorkerCommand>;
  pinMedia: Call<typeof transcriptMediaPinCommand>;
}

type Send = <C extends AnyCommandDef>(def: C, args: ArgsOf<C>) => Promise<ResultOf<C>>;

function artifactsApi(send: Send): TranscriptArtifactsApi {
  return {
    artifactCapabilities: (args) => send(transcriptArtifactCapabilitiesCommand, args),
    getPublication: (args) => send(transcriptArtifactGetPublicationCommand, args),
    listPublications: (args) => send(transcriptArtifactListPublicationsCommand, args),
    readRepresentation: (args) => send(transcriptArtifactReadRepresentationCommand, args),
    openLiveSession: (args) => send(transcriptArtifactOpenLiveSessionCommand, args),
    closeLiveSession: (args) => send(transcriptArtifactCloseLiveSessionCommand, args),
    renderMermaid: (args) => send(transcriptArtifactRenderMermaidCommand, args),
    workflowLiveSnapshot: (args) => send(transcriptArtifactWorkflowLiveSnapshotCommand, args),
    listDrafts: (args) => send(transcriptArtifactListDraftsCommand, args),
    readDraft: (args) => send(transcriptArtifactReadDraftCommand, args),
    stageAsset: (args) => send(transcriptArtifactStageAssetCommand, args),
    openMediaStream: (args) => send(transcriptMediaOpenStreamCommand, args),
    closeMediaStream: (args) => send(transcriptMediaCloseStreamCommand, args),
    mediaPdfPreview: (args) => send(transcriptMediaPdfPreviewCommand, args),
    prepareWorker: (args) => send(transcriptArtifactPrepareWorkerCommand, args),
    pinMedia: (args) => send(transcriptMediaPinCommand, args),
  };
}

/** Version 1: typed calls with the envelope, results decoded. */
export function transcriptArtifactsApiV1(call: CommandCall): TranscriptArtifactsApi {
  return artifactsApi(call);
}

/** Version 0: today's untyped call, without an envelope or decoding. */
export function transcriptArtifactsApiLegacy(
  _call: CommandCall,
  context: DomainAdapterContext,
): TranscriptArtifactsApi {
  return artifactsApi(
    <C extends AnyCommandDef>(def: C, args: ArgsOf<C>) =>
      context.invoke(def.name, args as Readonly<Record<string, unknown>>) as Promise<ResultOf<C>>,
  );
}
