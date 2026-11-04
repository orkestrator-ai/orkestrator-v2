/**
 * Splits an agent's stdout into JSONL frames.
 *
 * A frame can span many chunks, so each chunk is searched on its own (a newline
 * is one byte and cannot straddle two) and held until one arrives. The bytes
 * are joined once per frame, which keeps a large frame linear in its size
 * rather than copying and rescanning everything held on every chunk.
 */
export type JsonlFrameFailure = "oversized" | "unterminated-oversized";

export class JsonlLineFramer {
  readonly #maxLineBytes: number;
  #held: Buffer[] = [];
  #heldBytes = 0;

  constructor(maxLineBytes: number) {
    this.#maxLineBytes = maxLineBytes;
  }

  /**
   * Hands every frame the chunk completes to `onLine`, in order. Stops at a frame
   * over the limit, and reports a held remainder that is already over it.
   */
  accept(chunk: Buffer, onLine: (line: string) => void): JsonlFrameFailure | undefined {
    let start = 0;
    let newline = chunk.indexOf(0x0a, start);
    while (newline >= 0) {
      const lineBytes = this.#heldBytes + newline - start;
      if (lineBytes > this.#maxLineBytes) {
        this.discard();
        return "oversized";
      }
      onLine(this.#takeLine(chunk.subarray(start, newline), lineBytes));
      start = newline + 1;
      newline = chunk.indexOf(0x0a, start);
    }
    if (start < chunk.length) {
      this.#held.push(start === 0 ? chunk : chunk.subarray(start));
      this.#heldBytes += chunk.length - start;
    }
    if (this.#heldBytes > this.#maxLineBytes) {
      this.discard();
      return "unterminated-oversized";
    }
    return undefined;
  }

  discard(): void {
    this.#held = [];
    this.#heldBytes = 0;
  }

  #takeLine(tail: Buffer, lineBytes: number): string {
    if (this.#held.length === 0) return tail.toString("utf8");
    this.#held.push(tail);
    const line = Buffer.concat(this.#held, lineBytes).toString("utf8");
    this.discard();
    return line;
  }
}
