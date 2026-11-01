/**
 * Optimistic concurrency for editor saves.
 *
 * An editor loads a file, the user edits it, and the save writes the buffer
 * back. Without a check, anything that changed the file in between (an agent,
 * a terminal, another window) is silently overwritten. A save therefore
 * carries the SHA-256 of the content the editor loaded; the backend compares
 * it with the file as it is now and refuses the write with
 * `FILE_WRITE_CONFLICT_MESSAGE` when they differ or the file is gone. An
 * explicit overwrite is a save without the precondition.
 */
import { sha256Hex } from "./graphs/sha256.js";

export interface FileWritePrecondition {
  /** Lower-case hex SHA-256 of the UTF-8 content the editor loaded. */
  sha256: string;
}

/** Stable prefix: the error crosses the command transport as a message only. */
export const FILE_WRITE_CONFLICT_CODE = "file-write-conflict";

export const FILE_WRITE_CONFLICT_MESSAGE = `${FILE_WRITE_CONFLICT_CODE}: The file changed on disk since it was opened`;

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** The SHA-256 the backend compares a file's current bytes against. */
export function fileContentSha256(content: string): string {
  return sha256Hex(content);
}

/** Validate a precondition from a command argument; absent means "no check". */
export function parseFileWritePrecondition(value: unknown): FileWritePrecondition | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== "sha256")
  ) {
    throw new Error("expected must be an object with a sha256 digest");
  }
  const sha256 = (value as { sha256?: unknown }).sha256;
  if (typeof sha256 !== "string" || !SHA256_HEX.test(sha256)) {
    throw new Error("expected.sha256 must be a lower-case hex SHA-256 digest");
  }
  return { sha256 };
}

/** Whether a save failed because the file changed since it was loaded. */
export function isFileWriteConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(FILE_WRITE_CONFLICT_CODE);
}
