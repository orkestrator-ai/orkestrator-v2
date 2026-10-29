/**
 * `transcript_media_pin` (`@orkestrator/protocol/transcript-media-pins`): the
 * bytes of a local image as the naming message first showed it.
 *
 * A saved pin answers without reading anything. Otherwise the file is read
 * ONLY through the backend's existing readers, invoked as the registered
 * commands so their confinement applies unchanged (as
 * `transcript_media_pdf_preview` does):
 * - `read_file_base64` for an absolute host path;
 * - `read_container_file_base64` for a `/workspace` path of the environment's
 *   own container (any other container id is refused).
 * Reader errors propagate unchanged, so the renderer reports the same
 * outside-workspace, denied and too-large states it does for a direct read.
 */
import { stat } from "node:fs/promises";
import {
  TRANSCRIPT_MEDIA_PIN_COMMAND,
  type TranscriptMediaPinResponse,
} from "@orkestrator/protocol/transcript-media-pins";
import type { CommandContext } from "./commands-context.js";
import type { CommandRegistrar } from "./commands-registry-types.js";
import { containerRelativePath, type CommandLookup } from "./transcript-artifacts/index.js";
import { transcriptMediaPins, type TranscriptMediaFileRead } from "./transcript-media-pins.js";

const MAX_IDENTIFIER_LENGTH = 512;
const MAX_PATH_LENGTH = 4_096;
const ARGUMENTS = ["environmentId", "logicalSessionKey", "messageId", "path", "containerId"];

function identifier(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_IDENTIFIER_LENGTH) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function invokeReader(
  lookup: CommandLookup,
  name: string,
  args: Record<string, unknown>,
  context: CommandContext,
): Promise<Uint8Array> {
  const handler = lookup(name);
  if (!handler) throw new Error("The file reader is unavailable");
  const base64 = await handler(args as never, context);
  if (typeof base64 !== "string") throw new Error("The file could not be read");
  return new Uint8Array(Buffer.from(base64.trim(), "base64"));
}

/** Informational only: the read itself already passed the reader's confinement. */
async function hostModifiedAt(filePath: string): Promise<string | undefined> {
  const info = await stat(filePath).catch(() => null);
  return info ? info.mtime.toISOString() : undefined;
}

export function registerTranscriptMediaCommands(
  register: CommandRegistrar,
  lookup: CommandLookup,
): void {
  register(TRANSCRIPT_MEDIA_PIN_COMMAND, async (args, context) => {
    const unknown = Object.keys(args).filter((key) => !ARGUMENTS.includes(key));
    if (unknown.length > 0) throw new Error(`Unknown arguments: ${unknown.slice(0, 5).join(", ")}`);
    const environmentId = identifier(args.environmentId, "environmentId");
    const logicalSessionKey = identifier(args.logicalSessionKey, "logicalSessionKey");
    const messageId = identifier(args.messageId, "messageId");
    const filePath = args.path;
    if (
      typeof filePath !== "string" ||
      !filePath ||
      filePath.length > MAX_PATH_LENGTH ||
      /[\0\r\n]/.test(filePath)
    ) {
      throw new Error("path is required");
    }
    const environment = await context.storage.getEnvironment(environmentId);
    if (!environment) throw new Error("Environment not found");

    let reference: string;
    let read: () => Promise<TranscriptMediaFileRead>;
    if (args.containerId !== undefined) {
      if (
        typeof args.containerId !== "string" ||
        !environment.containerId ||
        args.containerId !== environment.containerId
      ) {
        throw new Error("Access denied: the container does not belong to this environment");
      }
      const relative = containerRelativePath(filePath);
      if (!relative) throw new Error("Invalid file path: file is outside the container workspace");
      reference = `container:${relative}`;
      read = async () => ({
        bytes: await invokeReader(
          lookup,
          "read_container_file_base64",
          { containerId: environment.containerId, filePath: relative },
          context,
        ),
      });
    } else {
      if (!filePath.startsWith("/")) throw new Error("A host path must be absolute");
      reference = `host:${filePath}`;
      read = async () => {
        const bytes = await invokeReader(lookup, "read_file_base64", { filePath }, context);
        const modifiedAt = await hostModifiedAt(filePath);
        return { bytes, ...(modifiedAt ? { modifiedAt } : {}) };
      };
    }

    const result = await transcriptMediaPins(context.storage.getDataDir()).pin(
      { environmentId, logicalSessionKey, messageId, reference },
      read,
    );
    return {
      status: result.status,
      capturedAt: result.capturedAt,
      ...(result.fileModifiedAt ? { fileModifiedAt: result.fileModifiedAt } : {}),
      ...(result.reason ? { reason: result.reason } : {}),
      sha256: result.sha256,
      byteLength: result.bytes.byteLength,
      dataBase64: Buffer.from(result.bytes).toString("base64"),
    } satisfies TranscriptMediaPinResponse;
  });
}
