/**
 * Renderer commands for PDF previews and preview-worker preparation.
 *
 * `transcript_media_pdf_preview` reads a PDF attachment ONLY through the
 * backend's existing authorized readers, invoked as the registered commands
 * themselves so their confinement applies unchanged:
 * - `read_file_base64` for an absolute host path (worktree roots only);
 * - `read_container_file_base64` for a `/workspace` path of the environment's
 *   own container (the container id must be that environment's);
 * - `get_native_agent_tool_details` for a deferred tool detail of one of the
 *   environment's conversations (its inline `data:` bytes).
 * The bytes then go to the isolated worker (service-media-pdf.ts).
 *
 * `transcript_artifact_prepare_worker` builds or pulls the container worker
 * with fixed arguments and re-selects isolation (preview-worker-prepare.ts).
 */
import { TRANSCRIPT_ARTIFACT_COMMANDS } from "@orkestrator/protocol/transcript-artifact-commands";
import { ArtifactFailure, artifactError } from "@orkestrator/protocol/transcript-artifacts";

import type { CommandContext, CommandHandler } from "../commands-context.js";
import type { CommandRegistrar } from "../commands-registry-types.js";
import { artifactCommandError } from "./commands.js";

/** Looks up another registered command at call time (registration order does not matter). */
export type CommandLookup = (name: string) => CommandHandler | undefined;

const MAX_PATH_LENGTH = 4_096;

function invalid(message: string): never {
  throw artifactCommandError(artifactError("invalid_input", message));
}

function readerFailure(message: string): ArtifactFailure {
  return new ArtifactFailure(artifactError("not_found", message));
}

/** Workspace-relative container path, or null when it would escape `/workspace`. */
export function containerRelativePath(value: string): string | null {
  if (!value || value.length > MAX_PATH_LENGTH || /[\0\r\n]/.test(value)) return null;
  let relative = value;
  if (relative.startsWith("/workspace/")) relative = relative.slice("/workspace/".length);
  else if (relative.startsWith("/") || relative.startsWith("~") || relative.startsWith("\\"))
    return null;
  if (!relative || /^[a-z]:[\\/]/i.test(relative)) return null;
  if (relative.split(/[\\/]+/).some((segment) => segment === "..")) return null;
  return relative;
}

function decodeBase64(value: unknown): Uint8Array {
  if (typeof value !== "string") throw readerFailure("The file could not be read");
  return new Uint8Array(Buffer.from(value.trim(), "base64"));
}

/** Bytes of a `data:…;base64,` URL, or null. */
function dataUrlBytes(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || !value.startsWith("data:")) return null;
  const comma = value.indexOf(",");
  if (comma < 0 || !/;base64$/i.test(value.slice(0, comma))) return null;
  return new Uint8Array(Buffer.from(value.slice(comma + 1), "base64"));
}

async function call(
  lookup: CommandLookup,
  name: string,
  args: Record<string, unknown>,
  context: CommandContext,
): Promise<unknown> {
  const handler = lookup(name);
  if (!handler) throw readerFailure("The file reader is unavailable");
  return handler(args as never, context);
}

export function registerTranscriptArtifactPdfCommands(
  register: CommandRegistrar,
  lookup: CommandLookup,
): void {
  register(TRANSCRIPT_ARTIFACT_COMMANDS.prepareWorker, async (_args, context) => {
    const service = context.transcriptArtifacts;
    if (!service)
      throw artifactCommandError(
        artifactError("storage_unavailable", "Transcript artifacts are unavailable"),
      );
    return service.prepareWorker();
  });

  register(TRANSCRIPT_ARTIFACT_COMMANDS.mediaPdfPreview, async (args, context) => {
    const service = context.transcriptArtifacts;
    if (!service)
      throw artifactCommandError(
        artifactError("storage_unavailable", "Transcript artifacts are unavailable"),
      );
    const environmentId = args.environmentId;
    if (typeof environmentId !== "string" || !environmentId || environmentId.length > 256)
      invalid("environmentId is required");
    const source = args.source as Record<string, unknown> | undefined;
    if (!source || typeof source !== "object" || Array.isArray(source))
      invalid("source is required");
    const environment = await context.storage.getEnvironment(environmentId);
    if (!environment)
      throw artifactCommandError(artifactError("not_found", "Environment not found"));

    let read: () => Promise<Uint8Array>;
    if (typeof source.detailRef === "string") {
      const { detailRef, agent, logicalSessionKey } = source;
      if (typeof agent !== "string" || typeof logicalSessionKey !== "string")
        invalid("agent and logicalSessionKey are required with detailRef");
      read = async () => {
        const details = (await call(
          lookup,
          "get_native_agent_tool_details",
          { environmentId, agent, logicalSessionKey, detailRef },
          context,
        )) as { fileDataUrl?: unknown } | null;
        const bytes = dataUrlBytes(details?.fileDataUrl);
        if (!bytes) throw readerFailure("The attachment's bytes are not part of its tool detail");
        return bytes;
      };
    } else if (typeof source.path === "string") {
      const filePath = source.path;
      if (source.containerId !== undefined) {
        if (typeof source.containerId !== "string" || !source.containerId)
          invalid("containerId must be a string");
        if (!environment.containerId || source.containerId !== environment.containerId)
          throw artifactCommandError(
            artifactError("policy_denied", "The container does not belong to this environment"),
          );
        const relative = containerRelativePath(filePath);
        if (!relative) invalid("The path must stay inside /workspace");
        read = async () =>
          decodeBase64(
            await call(
              lookup,
              "read_container_file_base64",
              { containerId: environment.containerId, filePath: relative },
              context,
            ),
          );
      } else {
        if (
          !filePath.startsWith("/") ||
          filePath.length > MAX_PATH_LENGTH ||
          filePath.includes("\0")
        )
          invalid("A host path must be absolute");
        read = async () =>
          decodeBase64(await call(lookup, "read_file_base64", { filePath }, context));
      }
    } else {
      invalid("source needs a path or a detailRef");
    }
    return service.mediaPdfPreview(environmentId, async () => {
      try {
        return await read();
      } catch (error) {
        if (error instanceof ArtifactFailure) throw error;
        const message = error instanceof Error ? error.message : "";
        // Readers report their own limits (for example the 10 MiB binary read cap).
        throw new ArtifactFailure(
          artifactError(
            /too large|exceeds|limit/i.test(message) ? "package_size_exceeded" : "not_found",
            /too large|exceeds|limit/i.test(message)
              ? "The file is larger than the backend's attachment read limit"
              : "The file could not be read; it may have moved, or access was denied",
          ),
        );
      }
    });
  });
}
