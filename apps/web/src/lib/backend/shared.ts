export interface TerminalSessionCreateResult {
  sessionId: string;
  created: boolean;
  bootstrapped: boolean;
}

export function parseTerminalSessionCreateResult(value: unknown): TerminalSessionCreateResult {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { sessionId?: unknown }).sessionId !== "string" ||
    (value as { sessionId: string }).sessionId.length === 0 ||
    typeof (value as { created?: unknown }).created !== "boolean" ||
    ((value as { bootstrapped?: unknown }).bootstrapped !== undefined &&
      typeof (value as { bootstrapped?: unknown }).bootstrapped !== "boolean")
  ) {
    throw new Error("Backend returned an invalid terminal session result");
  }
  return {
    ...(value as Omit<TerminalSessionCreateResult, "bootstrapped">),
    // Compatibility with the previous backend for one release.
    bootstrapped: (value as { bootstrapped?: boolean }).bootstrapped ?? false,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * A backend that can no longer reach a session's PTY reports the refusal in
 * band as `{ delivered: false }` rather than throwing, so a caller that
 * discards the result silently tells the user a keystroke landed in a shell
 * that is gone. Only an explicit `false` is proof of non-delivery: older
 * backends omit the field entirely, so anything else is read as delivered.
 */
export function terminalWriteWasDelivered(result: unknown): boolean {
  return !(
    typeof result === "object" &&
    result !== null &&
    (result as { delivered?: unknown }).delivered === false
  );
}

/**
 * The backend predates exactly this command, so the caller takes its
 * compatibility path. Only the backend's own answer naming the command counts:
 * any other failure may mean the launch already ran, and falling back then
 * would run it twice.
 */
export function isUnsupportedBackendCommand(error: unknown, command: string): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  // The dispatcher's wording, and the one the node-routing code also checks for.
  return (
    message.includes(`Unknown backend command: ${command}`) ||
    message.includes(`Unknown command: ${command}`)
  );
}
