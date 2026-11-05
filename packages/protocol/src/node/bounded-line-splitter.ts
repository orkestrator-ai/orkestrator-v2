/**
 * Reassembles a child process's output into whole lines, bounded so a process
 * that never prints a newline cannot grow the reader's memory.
 *
 * Shared by the two stdio relays: the desktop reading its Local backend
 * (`apps/desktop/electron/backend-process.ts`) and the backend reading a local
 * bridge (`apps/backend/src/core/bridge-output-redaction.ts`). It replaces the
 * desktop's `readline`, which buffers a whole line however long it is, so it
 * ends lines where `readline` did: at `\n`, `\r\n` and a lone `\r`. U+2028 and
 * U+2029 do not end a line, here or in Node's `readline` (Electron's); Bun's
 * `readline` differs there.
 */
import { StringDecoder } from "node:string_decoder";

/**
 * Longest partial line held back waiting for its line end, in UTF-16 units.
 * It matches the log file writer's per-entry bound, so a longer line could not
 * have been saved whole anyway.
 */
export const PROCESS_OUTPUT_LINE_LIMIT = 64 * 1024;

export type BoundedLineSplitter = {
  /** Add a chunk; every line it completes is passed on before this returns. */
  push(chunk: Buffer | string): void;
  /** The stream ended: pass on a final line that has no line end. */
  flush(): void;
};

const LINE_END = /\r\n|\r|\n/g;

/** Where to cut a run of at least `limit` units: never between a surrogate pair. */
function cutIndex(text: string, limit: number): number {
  const last = text.charCodeAt(limit - 1);
  return limit > 1 && last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit;
}

/**
 * Calls `onLine` once per line, without its line end, and never with more than
 * `limit` units. A line longer than that is passed on in pieces of `limit`
 * rather than held or lost, the last piece once its line end arrives. Bytes are decoded as UTF-8 across chunk boundaries,
 * so a character split between two chunks is not corrupted.
 */
export function createBoundedLineSplitter(
  onLine: (line: string) => void,
  limit = PROCESS_OUTPUT_LINE_LIMIT,
): BoundedLineSplitter {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  // A chunk ended on `\r`: the `\n` of the same `\r\n` may open the next one.
  let skipLeadingNewline = false;

  // Cut rather than lose output; a record split here stays as plain text.
  const emit = (line: string) => {
    while (line.length > limit) {
      const cut = cutIndex(line, limit);
      onLine(line.slice(0, cut));
      line = line.slice(cut);
    }
    onLine(line);
  };

  const take = (text: string) => {
    if (!text) return;
    if (skipLeadingNewline) {
      skipLeadingNewline = false;
      if (text.startsWith("\n")) text = text.slice(1);
      if (!text) return;
    }
    // The held text has no line end in it, so only the new text is searched.
    const searchFrom = pending.length;
    pending += text;
    LINE_END.lastIndex = searchFrom;
    let start = 0;
    for (let match = LINE_END.exec(pending); match; match = LINE_END.exec(pending)) {
      emit(pending.slice(start, match.index));
      start = match.index + match[0].length;
      if (match[0] === "\r" && start === pending.length) skipLeadingNewline = true;
    }
    pending = start === 0 ? pending : pending.slice(start);
    while (pending.length > limit) {
      const cut = cutIndex(pending, limit);
      onLine(pending.slice(0, cut));
      pending = pending.slice(cut);
    }
  };

  return {
    push(chunk) {
      take(typeof chunk === "string" ? chunk : decoder.write(chunk));
    },
    flush() {
      take(decoder.end());
      skipLeadingNewline = false;
      if (!pending) return;
      const rest = pending;
      pending = "";
      emit(rest);
    },
  };
}

/** Feed `stream` through a bounded splitter until it ends. */
export function forEachBoundedLine(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
  limit = PROCESS_OUTPUT_LINE_LIMIT,
): void {
  const splitter = createBoundedLineSplitter(onLine, limit);
  stream.on("data", (chunk: Buffer | string) => splitter.push(chunk));
  stream.once("end", () => splitter.flush());
}
