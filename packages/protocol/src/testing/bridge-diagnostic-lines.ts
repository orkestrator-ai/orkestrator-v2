/**
 * The snapshot a bridge diagnostic log line carries, for tests that read lines
 * the way they reach the console. Text mode writes it as the last field:
 * `[bridge-diagnostics] heartbeat bridge=claude payload="{...}"`.
 */
const DIAGNOSTIC_LINE = /^\[bridge-diagnostics\] \S+ bridge=\S+ payload=(".*")$/;

export function bridgeDiagnosticPayload(line: string): Record<string, unknown> | null {
  const match = DIAGNOSTIC_LINE.exec(line);
  return match ? (JSON.parse(JSON.parse(match[1]!) as string) as Record<string, unknown>) : null;
}

/** Every snapshot in `lines`, in order, skipping anything else. */
export function bridgeDiagnosticPayloads(lines: readonly string[]): Array<Record<string, any>> {
  return lines.flatMap((line) => {
    const payload = bridgeDiagnosticPayload(line);
    return payload ? [payload] : [];
  });
}
