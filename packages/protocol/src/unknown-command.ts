/**
 * A backend's answer to a command it does not have, which is how a caller
 * recognises an older backend or node.
 *
 * `OrkestratorBackend.invoke` throws this wording, the gateway sends the
 * message as the invoke error and a node link raises it unchanged, so a
 * command node sees the same text a local caller does. No backend has ever
 * answered with a plain `Unknown command:`; a check for that wording never
 * matches a real node.
 */
export function unknownBackendCommandMessage(command: string): string {
  return `Unknown backend command: ${command}`;
}

/**
 * Whether `error` is the unknown-command answer for exactly `command`. A
 * wrapper's prefix is allowed, but a longer command name is not a match:
 * `get_x_v2` is not `get_x`.
 */
export function isUnknownCommandError(error: unknown, command: string): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const expected = unknownBackendCommandMessage(command);
  for (let at = message.indexOf(expected); at >= 0; at = message.indexOf(expected, at + 1)) {
    const next = message.charAt(at + expected.length);
    if (!/[A-Za-z0-9_-]/.test(next)) return true;
  }
  return false;
}
