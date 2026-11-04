import type { EssentialLogBounds, EssentialLogIo } from "./essential-log.js";

/** Self-contained transaction shared by the worker and synchronous exit fallback. */
export function essentialLogTransactionFactory(
  fs: EssentialLogIo,
  path: typeof import("node:path"),
  directory: string,
  bounds: EssentialLogBounds,
): (payload: Uint8Array) => void {
  const fileAt = (index: number) =>
    path.join(directory, index === 0 ? "essential.jsonl" : `essential.${index}.jsonl`);
  const missingIsFine = (error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  };
  return (payload) => {
    if (payload.byteLength > bounds.maxFileBytes)
      throw new Error("Essential log entry exceeds file bound");
    let size = 0;
    try {
      size = fs.statSync(fileAt(0)).size;
    } catch (error) {
      missingIsFine(error);
    }
    if (size > 0 && size + payload.byteLength > bounds.maxFileBytes) {
      // Remove the oldest destination first. Every remaining rename now targets
      // an absent path on Windows as well as POSIX.
      try {
        fs.unlinkSync(fileAt(bounds.rotatedFiles));
      } catch (error) {
        missingIsFine(error);
      }
      for (let index = bounds.rotatedFiles; index >= 1; index -= 1) {
        try {
          fs.renameSync(fileAt(index - 1), fileAt(index));
        } catch (error) {
          missingIsFine(error);
        }
      }
    }
    fs.appendFileSync(fileAt(0), payload, { mode: 0o600 });
  };
}
