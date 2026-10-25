/**
 * Renderer commands for transcript artifacts (names and shapes in
 * `@orkestrator/protocol/transcript-artifact-commands`).
 *
 * Reads are scoped by the conversation the renderer displays
 * (`environmentId` + `logicalSessionKey`) and answer `not_found` for anything
 * that conversation does not own.
 *
 * Failures reject with an `Error` whose `message` is the JSON text of an
 * `ArtifactError` (`{"code":"not_found","message":"…","retryClass":"never",…}`),
 * because the gateway forwards only `error.message` to the renderer. In
 * process, the same Error also carries `code` and `error` properties.
 */
import { TRANSCRIPT_ARTIFACT_COMMANDS } from "@orkestrator/protocol/transcript-artifact-commands";
import type {
  ArtifactDraftReadRequest,
  ArtifactRepresentation,
  ArtifactRepresentationRequest,
} from "@orkestrator/protocol/transcript-artifact-commands";
import {
  ArtifactFailure,
  artifactError,
  type ArtifactError,
  type ArtifactErrorCode,
} from "@orkestrator/protocol/transcript-artifacts";
import type { CommandContext } from "../commands-context.js";
import type { CommandRegistrar } from "../commands-registry-types.js";
import type { TranscriptArtifactService } from "./service.js";
import path from "node:path";
import { TranscriptMediaStreams, type MediaStreamServer } from "./media-stream.js";
import { spawnDockerMediaReader } from "./media-stream-container.js";

const REPRESENTATIONS: readonly ArtifactRepresentation[] = [
  "source",
  "effective-html",
  "prepared-html",
  "capture",
  "rendered-svg",
  "chart-json",
  "chart-csv",
  "workflow-json",
  "pdf",
];

/** The rejection every artifact command uses: JSON message plus `code`/`error` properties. */
export function artifactCommandError(
  error: ArtifactError,
): Error & { code: ArtifactErrorCode; error: ArtifactError } {
  const safe: ArtifactError = {
    code: error.code,
    message: error.message.slice(0, 500),
    retryClass: error.retryClass,
    ...(error.currentRevision !== undefined ? { currentRevision: error.currentRevision } : {}),
    ...(error.resource ? { resource: error.resource } : {}),
    ...(error.fieldErrors ? { fieldErrors: error.fieldErrors.slice(0, 20) } : {}),
  };
  return Object.assign(new Error(JSON.stringify(safe)), { code: safe.code, error: safe });
}

/** The fixed print profile's paper; anything else is refused, never coerced. */
function printPaper(value: unknown): "a4" | "letter" {
  if (value === "a4" || value === "letter") return value;
  fail("invalid_input", "paper must be a4 or letter");
}

function fail(code: ArtifactErrorCode, message: string): never {
  throw artifactCommandError(artifactError(code, message));
}

function service(context: CommandContext): TranscriptArtifactService {
  const artifacts = context.transcriptArtifacts;
  if (!artifacts) fail("storage_unavailable", "Transcript artifacts are unavailable");
  return artifacts;
}

async function guarded<T>(work: () => Promise<T> | T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ArtifactFailure) throw artifactCommandError(error.error);
    if (error instanceof Error && "code" in error && "error" in error) throw error;
    throw artifactCommandError(
      artifactError("storage_unavailable", "The artifact store is temporarily unavailable"),
    );
  }
}

function scope(args: Record<string, unknown>): {
  environmentId: string;
  logicalSessionKey: string;
} {
  if (typeof args.environmentId !== "string" || typeof args.logicalSessionKey !== "string") {
    fail("invalid_input", "environmentId and logicalSessionKey are required");
  }
  return { environmentId: args.environmentId, logicalSessionKey: args.logicalSessionKey };
}

function optionalInteger(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail("invalid_input", `${name} must be a non-negative integer`);
  }
  return value;
}

/** One media stream manager per artifact service (and so per backend). */
const mediaStreamManagers = new WeakMap<TranscriptArtifactService, TranscriptMediaStreams>();

function mediaStreams(context: CommandContext): TranscriptMediaStreams {
  const artifacts = service(context);
  const existing = mediaStreamManagers.get(artifacts);
  if (existing) return existing;
  const storage = context.storage;
  if (!storage) fail("renderer_unavailable", "Media streaming is unavailable");
  const created = new TranscriptMediaStreams({
    server: () => {
      const server = artifacts.runtime().contentServer as Partial<MediaStreamServer> | undefined;
      return server && typeof server.mintMedia === "function"
        ? (server as MediaStreamServer)
        : null;
    },
    getEnvironment: async (environmentId) => (await storage.getEnvironment(environmentId)) ?? null,
    stagingRoot: path.join(storage.getDataDir(), "transcript-media-staging"),
    spawnContainerReader: spawnDockerMediaReader,
  });
  mediaStreamManagers.set(artifacts, created);
  return created;
}

export function registerTranscriptArtifactCommands(register: CommandRegistrar): void {
  register(TRANSCRIPT_ARTIFACT_COMMANDS.capabilities, async (_args, context) =>
    service(context).capabilities(),
  );

  register(TRANSCRIPT_ARTIFACT_COMMANDS.getPublication, async (args, context) =>
    guarded(() => service(context).getPublication(scope(args), args.publicationId)),
  );

  register(TRANSCRIPT_ARTIFACT_COMMANDS.listPublications, async (args, context) =>
    guarded(() =>
      service(context).listPublications(scope(args), {
        afterSequence: optionalInteger(args.afterSequence, "afterSequence"),
        limit: optionalInteger(args.limit, "limit"),
      }),
    ),
  );

  register(TRANSCRIPT_ARTIFACT_COMMANDS.readRepresentation, async (args, context) =>
    guarded(() => {
      const representation = args.representation;
      if (
        typeof representation !== "string" ||
        !(REPRESENTATIONS as readonly string[]).includes(representation)
      ) {
        fail("invalid_input", "Unknown representation");
      }
      if (typeof args.publicationId !== "string") fail("not_found", "Publication not found");
      const range = args.sourceRange as { offsetBytes?: unknown; limitBytes?: unknown } | undefined;
      const request: ArtifactRepresentationRequest = {
        ...scope(args),
        publicationId: args.publicationId,
        representation: representation as ArtifactRepresentation,
        ...(representation === "pdf"
          ? {
              paper:
                args.paper === undefined || args.paper === "a4" ? "a4" : printPaper(args.paper),
            }
          : {}),
        ...(optionalInteger(args.captureIndex, "captureIndex") !== undefined
          ? { captureIndex: optionalInteger(args.captureIndex, "captureIndex")! }
          : {}),
        ...(range
          ? {
              sourceRange: {
                offsetBytes: optionalInteger(range.offsetBytes, "sourceRange.offsetBytes") ?? 0,
                limitBytes:
                  optionalInteger(range.limitBytes, "sourceRange.limitBytes") ?? 1024 * 1024,
              },
            }
          : {}),
      };
      return service(context).readRepresentation(request);
    }),
  );

  register(TRANSCRIPT_ARTIFACT_COMMANDS.openLiveSession, async (args, context) =>
    guarded(() => service(context).openLiveSession(scope(args), args.publicationId)),
  );

  register(TRANSCRIPT_ARTIFACT_COMMANDS.closeLiveSession, async (args, context) => {
    service(context).closeLiveSession(args.generation);
    return null;
  });

  register(TRANSCRIPT_ARTIFACT_COMMANDS.renderMermaid, async (args, context) =>
    guarded(() =>
      service(context).renderMermaid({
        source: typeof args.source === "string" ? args.source : "",
        theme: args.theme === "dark" ? "dark" : "light",
      }),
    ),
  );

  register(TRANSCRIPT_ARTIFACT_COMMANDS.listDrafts, async (args, context) =>
    guarded(() =>
      service(context).listDrafts(scope(args), { limit: optionalInteger(args.limit, "limit") }),
    ),
  );

  register(TRANSCRIPT_ARTIFACT_COMMANDS.readDraft, async (args, context) =>
    guarded(() => {
      const representation = args.representation;
      if (representation !== "source" && representation !== "diagnostic-capture") {
        fail("invalid_input", "Unknown draft representation");
      }
      if (typeof args.artifactId !== "string") fail("not_found", "Artifact not found");
      const revision = optionalInteger(args.revision, "revision");
      const captureIndex = optionalInteger(args.captureIndex, "captureIndex");
      const range = args.sourceRange as { offsetBytes?: unknown; limitBytes?: unknown } | undefined;
      const request: ArtifactDraftReadRequest = {
        ...scope(args),
        artifactId: args.artifactId,
        representation,
        ...(revision !== undefined ? { revision } : {}),
        ...(typeof args.operationId === "string" ? { operationId: args.operationId } : {}),
        ...(captureIndex !== undefined ? { captureIndex } : {}),
        ...(range
          ? {
              sourceRange: {
                offsetBytes: optionalInteger(range.offsetBytes, "sourceRange.offsetBytes") ?? 0,
                limitBytes:
                  optionalInteger(range.limitBytes, "sourceRange.limitBytes") ?? 1024 * 1024,
              },
            }
          : {}),
      };
      return service(context).readDraft(request);
    }),
  );

  register(TRANSCRIPT_ARTIFACT_COMMANDS.stageAsset, async (args, context) =>
    guarded(() => {
      const target = scope(args);
      if (
        typeof args.name !== "string" ||
        typeof args.mimeType !== "string" ||
        typeof args.dataBase64 !== "string"
      ) {
        fail("invalid_input", "name, mimeType and dataBase64 are required");
      }
      return service(context).stageAsset({
        ...target,
        name: args.name,
        mimeType: args.mimeType,
        dataBase64: args.dataBase64,
      });
    }),
  );

  // Range-capable media playback through the content origin (media-stream.ts).
  register(TRANSCRIPT_ARTIFACT_COMMANDS.openMediaStream, async (args, context) =>
    guarded(() => mediaStreams(context).open(args)),
  );

  register(TRANSCRIPT_ARTIFACT_COMMANDS.closeMediaStream, async (args, context) => {
    if (context.transcriptArtifacts)
      mediaStreamManagers.get(context.transcriptArtifacts)?.close(args.streamId);
    return null;
  });

  register(TRANSCRIPT_ARTIFACT_COMMANDS.workflowLiveSnapshot, async (args, context) =>
    guarded(() =>
      service(context).workflowLiveSnapshot({
        environmentId: args.environmentId,
        workflowId: args.workflowId,
        runId: args.runId,
      }),
    ),
  );
}
