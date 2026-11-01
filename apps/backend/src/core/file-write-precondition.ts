/**
 * Server side of `@orkestrator/protocol/file-write-precondition`: an editor
 * save names the SHA-256 of the content it loaded, and the write happens only
 * while the file still has those bytes.
 */
import { createHash } from "node:crypto";
import {
  FILE_WRITE_CONFLICT_MESSAGE,
  type FileWritePrecondition,
} from "@orkestrator/protocol/file-write-precondition";
import { quoteShell } from "./commands-agent-support.js";
import { readTextFile } from "./shell.js";

export function fileWriteConflictError(): Error {
  return new Error(FILE_WRITE_CONFLICT_MESSAGE);
}

/**
 * Throw the conflict error unless the worktree file still has the expected
 * content. A file that is gone, unreadable or no longer editor text cannot
 * match, so it is a conflict too: the save must not recreate or clobber it
 * on the strength of a digest it no longer has.
 */
export async function assertLocalFileUnchanged(
  root: string,
  relativePath: string,
  expected: FileWritePrecondition,
): Promise<void> {
  let current: string;
  try {
    current = (await readTextFile(root, relativePath)).content;
  } catch {
    throw fileWriteConflictError();
  }
  // The editor read decodes losslessly (BOM kept), so re-encoding gives the
  // file's own bytes and the digest matches the one the client computed.
  const actual = createHash("sha256").update(current, "utf8").digest("hex");
  if (actual !== expected.sha256) throw fileWriteConflictError();
}

/** Exit status of the container writer when the precondition fails. */
export const CONTAINER_WRITE_CONFLICT_EXIT = 75;

/**
 * Shell for one container write: optionally verify the current digest, then
 * replace the file from base64 on stdin. Check and write run in one process,
 * so nothing else in the container sees a half-done save. The digest is
 * validated hex and the path is quoted, so neither can inject shell.
 */
export function containerFileWriteScript(
  fullPath: string,
  expected: FileWritePrecondition | undefined,
): string {
  const target = quoteShell(fullPath);
  const check = expected
    ? `if [ ! -f ${target} ]; then exit ${CONTAINER_WRITE_CONFLICT_EXIT}; fi; ` +
      `actual=$(sha256sum -- ${target} | cut -d' ' -f1) || exit 1; ` +
      `if [ "$actual" != ${quoteShell(expected.sha256)} ]; then exit ${CONTAINER_WRITE_CONFLICT_EXIT}; fi; `
    : "";
  return `${check}base64 -d > ${target}`;
}

const writeQueues = new Map<string, Promise<unknown>>();

/**
 * Run conditional writes to one file one at a time, so two saves that both
 * loaded the same content cannot both pass the check before either writes.
 */
export function serializeFileWrite<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  writeQueues.set(key, settled);
  void settled.then(() => {
    if (writeQueues.get(key) === settled) writeQueues.delete(key);
  });
  return next;
}
