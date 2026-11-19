/**
 * Server side of `@orkestrator/protocol/file-write-precondition`: an editor
 * save names the SHA-256 of the content it loaded, and the write happens only
 * while the file still has those bytes.
 *
 * Both writers publish atomically: the whole payload goes to a temporary file
 * beside the target, the precondition is checked again, and only then is the
 * temporary file renamed over the target. A reader never sees a partial save
 * and a refused or interrupted save leaves the file as it was. The local writer
 * is `writeFileBase64` (`expectedSha256`); the container writer is the script
 * below.
 *
 * Limitation, as for design export (`design/export-writer.ts`): the final step
 * is check-then-rename, not an atomic compare-and-swap. Orkestrator's own
 * saves to one file are serialized (`serializeFileWrite`), but an agent or a
 * terminal writing the file in the instant between the last check and the
 * rename is still replaced. The window is a few system calls wide.
 */
import { basename, dirname } from "node:path";
import {
  FILE_WRITE_CONFLICT_MESSAGE,
  type FileWritePrecondition,
} from "@orkestrator/protocol/file-write-precondition";
import { quoteShell } from "./commands-agent-support.js";

export function fileWriteConflictError(): Error {
  return new Error(FILE_WRITE_CONFLICT_MESSAGE);
}

/** The container writer refused a symlink, directory or other non-file target. */
export function fileWriteNotRegularFileError(): Error {
  return new Error("Cannot save: the path is not a regular file");
}

/** Exit status of the container writer when the precondition fails. */
export const CONTAINER_WRITE_CONFLICT_EXIT = 75;
/** Exit status of the container writer when the target is not a regular file. */
export const CONTAINER_WRITE_NOT_FILE_EXIT = 73;

/**
 * Shell for one container write. The digest is validated hex and every path is
 * quoted, so neither can inject shell.
 *
 * 1. With a precondition, refuse at once when the file is gone or differs
 *    (before reading stdin, so a stale save costs no transfer).
 * 2. Decode the complete payload into a temporary file in the target's
 *    directory and require exactly `byteLength` bytes; the target is not
 *    touched while bytes are still arriving, and a truncated transfer is
 *    discarded.
 * 3. Give it the target's permission bits (or the umask default for a new
 *    file), check the precondition again, and rename it over the target.
 *
 * A symlink or any other non-regular target is refused: the container editor
 * read never follows one, and `mv` would replace the link itself.
 */
export function containerFileWriteScript(
  fullPath: string,
  expected: FileWritePrecondition | undefined,
  byteLength: number,
): string {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw new Error("Invalid byte length");
  const target = quoteShell(fullPath);
  const directory = quoteShell(dirname(fullPath));
  const template = quoteShell(
    `${dirname(fullPath)}/.${basename(fullPath)}.orkestrator-save.XXXXXXXX`,
  );
  const notFile =
    `if [ -L ${target} ] || { [ -e ${target} ] && [ ! -f ${target} ]; }; then ` +
    `echo 'not a regular file' >&2; exit ${CONTAINER_WRITE_NOT_FILE_EXIT}; fi; `;
  const check = expected
    ? `if [ ! -f ${target} ] || [ -L ${target} ]; then exit ${CONTAINER_WRITE_CONFLICT_EXIT}; fi; ` +
      `actual=$(sha256sum -- ${target} | cut -d' ' -f1) || exit 1; ` +
      `if [ "$actual" != ${quoteShell(expected.sha256)} ]; then exit ${CONTAINER_WRITE_CONFLICT_EXIT}; fi; `
    : "";
  return (
    `${notFile}${check}` +
    `mkdir -p -- ${directory} || exit 1; ` +
    `tmp=$(mktemp ${template}) || exit 1; ` +
    `trap 'rm -f -- "$tmp"' EXIT; ` +
    `base64 -d > "$tmp" || exit 1; ` +
    // A client that died mid-transfer closes stdin early; never publish that.
    `if [ "$(wc -c < "$tmp" | tr -d ' ')" != ${byteLength} ]; then echo 'incomplete payload' >&2; exit 1; fi; ` +
    `if [ -f ${target} ]; then ` +
    `mode=$(stat -c %a -- ${target} 2>/dev/null || stat -f %Lp -- ${target}) || exit 1; ` +
    `else mode=$(printf %o $(( 0666 & ~0$(umask) ))); fi; ` +
    `chmod "$mode" "$tmp" || exit 1; ` +
    `${notFile}${check}` +
    `mv -f -- "$tmp" ${target} || exit 1; ` +
    `trap - EXIT`
  );
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
