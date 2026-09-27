/**
 * Process boundary of the client. Tests substitute buffers; the executable
 * binds the real streams. Keeping stdout and stderr separate is part of the
 * contract: machine output goes only to stdout, diagnostics only to stderr.
 */
export interface ClientIo {
  stdout(text: string): void;
  stdoutBytes(bytes: Uint8Array): void;
  stderr(text: string): void;
  /** Reads stdin up to `maxBytes`; throws `CliError("input-too-large")` beyond. */
  readStdin(maxBytes: number): Promise<Uint8Array>;
  env: Record<string, string | undefined>;
  cwd: string;
  now(): number;
  /** Whether stdin is an interactive terminal (prompt input then needs a file). */
  stdinIsTty: boolean;
}

export async function readStreamBounded(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  onOverflow: () => Error,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const onAbort = () => void reader.cancel(signal?.reason).catch(() => undefined);
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw onOverflow();
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
