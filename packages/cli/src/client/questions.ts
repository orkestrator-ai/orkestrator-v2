import { createInterface, type Interface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { CliError } from "./errors.js";
import { throwIfInterrupted } from "./wait.js";

/** One lazily opened reader for the whole setup, released on completion or abort. */
export function terminalQuestions(input: Readable, output: Writable, onInterrupt: () => void) {
  let reader: Interface | undefined;
  let ended = false;
  return {
    async question(prompt: string, signal?: AbortSignal): Promise<string | null> {
      throwIfInterrupted(signal);
      if (ended) return null;
      if (!reader) {
        reader = createInterface({ input, output });
        reader.once("close", () => {
          ended = true;
        });
        reader.on("SIGINT", onInterrupt);
      }
      const current = reader;
      let onClose: () => void = () => {};
      let onAbort: () => void = () => {};
      try {
        return await new Promise<string | null>((resolve, reject) => {
          onClose = () => resolve(null);
          onAbort = () => {
            reject(new CliError("observation-interrupted", "Interrupted"));
            current.close();
          };
          current.once("close", onClose);
          signal?.addEventListener("abort", onAbort, { once: true });
          if (signal?.aborted) {
            onAbort();
            return;
          }
          current.question(prompt).then(resolve, reject);
        });
      } finally {
        current.off("close", onClose);
        signal?.removeEventListener("abort", onAbort);
      }
    },
    close() {
      ended = true;
      reader?.close();
    },
  };
}
