import { isUnknownCommandError } from "@orkestrator/protocol/unknown-command";

/**
 * Whether a backend rejected `command` because it does not know it: an older
 * backend (or a remote machine on an older release) that predates the command.
 * Callers fall back to the older command only on this answer, never on any
 * other failure.
 *
 * The backend's answer is `unknownBackendCommandMessage(command)`, matched by
 * `isUnknownCommandError` (a wrapper's prefix is allowed, a longer command
 * name is not). A message that names the command and says it is not
 * available in this backend also counts.
 */
export function isUnknownBackendCommand(error: unknown, command: string): boolean {
  if (isUnknownCommandError(error, command)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(command) && /not available in this backend/i.test(message);
}
