/**
 * Whether a backend rejected `command` because it does not know it: an older
 * backend (or a remote machine on an older release) that predates the command.
 * Callers fall back to the older command only on this answer, never on any
 * other failure.
 */
export function isUnknownBackendCommand(error: unknown, command: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes(`Unknown command: ${command}`) ||
    (message.includes(command) && /not available in this backend/i.test(message))
  );
}
