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
