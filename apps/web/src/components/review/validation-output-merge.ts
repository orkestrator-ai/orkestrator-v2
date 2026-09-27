import {
  REVIEW_VALIDATION_OUTPUT_MAX_BYTES,
  type ReviewValidationOutput,
  type ReviewValidationOutputKnown,
  type ReviewValidationOutputStream,
} from "@orkestrator/protocol/review-workflow";

/**
 * Client half of the validation-output offset contract (step 09).
 *
 * The client holds a bounded tail per stream plus the backend's `anchor` for
 * the end of it, and sends `{ totalBytes, anchor }` back. The backend answers
 * `append` (only the new bytes) while the file merely grew, and an
 * authoritative `tail` after truncation, rotation, a generation reset or a gap
 * larger than the bound. An `append` this client cannot place (it no longer
 * holds the base it describes) is a resync: drop the held output and read an
 * authoritative tail. Identical answers keep the previous object so nothing
 * re-renders.
 */

function decode(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function encode(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function sameStream(
  left: ReviewValidationOutputStream | null,
  right: ReviewValidationOutputStream | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.totalBytes === right.totalBytes &&
    left.startOffset === right.startOffset &&
    left.anchor === right.anchor &&
    left.contentBase64 === right.contentBase64
  );
}

type StreamMerge = { stream: ReviewValidationOutputStream | null } | { resync: true };

function mergeStream(
  previous: ReviewValidationOutputStream | null | undefined,
  next: ReviewValidationOutputStream | null,
  maxBytes: number,
): StreamMerge {
  if (!next || next.mode !== "append") {
    // Authoritative tail (or an older backend's full answer).
    return { stream: previous && sameStream(previous, next) ? previous : next };
  }
  if (!previous || previous.totalBytes !== next.startOffset) return { resync: true };
  if (next.totalBytes === previous.totalBytes) {
    return {
      stream: previous.anchor === next.anchor ? previous : { ...previous, anchor: next.anchor },
    };
  }
  const held = decode(previous.contentBase64);
  const delta = decode(next.contentBase64);
  if (previous.startOffset + held.length !== previous.totalBytes) return { resync: true };
  const combined = new Uint8Array(held.length + delta.length);
  combined.set(held);
  combined.set(delta, held.length);
  const kept =
    combined.length > maxBytes ? combined.subarray(combined.length - maxBytes) : combined;
  return {
    stream: {
      contentBase64: encode(kept),
      totalBytes: next.totalBytes,
      startOffset: next.totalBytes - kept.length,
      ...(next.anchor ? { anchor: next.anchor } : {}),
      mode: "tail",
    },
  };
}

export type ValidationOutputMerge =
  | { output: ReviewValidationOutput; resync: false }
  | { output: null; resync: true };

export function mergeValidationOutput(
  previous: ReviewValidationOutput | null,
  next: ReviewValidationOutput,
  maxBytes = REVIEW_VALIDATION_OUTPUT_MAX_BYTES,
): ValidationOutputMerge {
  const base = previous && previous.resultId === next.resultId ? previous : null;
  const stdout = mergeStream(base?.stdout, next.stdout, maxBytes);
  const stderr = mergeStream(base?.stderr, next.stderr, maxBytes);
  if ("resync" in stdout || "resync" in stderr) return { output: null, resync: true };
  if (
    base &&
    base.status === next.status &&
    base.stdout === stdout.stream &&
    base.stderr === stderr.stream
  ) {
    return { output: base, resync: false };
  }
  return {
    output: { ...next, stdout: stdout.stream, stderr: stderr.stream },
    resync: false,
  };
}

/** The position to echo back; empty for an older backend that sends no anchor. */
export function knownValidationOutput(
  output: ReviewValidationOutput | null,
): ReviewValidationOutputKnown | undefined {
  if (!output) return undefined;
  const known: ReviewValidationOutputKnown = {};
  for (const name of ["stdout", "stderr"] as const) {
    const stream = output[name];
    if (stream?.anchor) known[name] = { totalBytes: stream.totalBytes, anchor: stream.anchor };
  }
  return known.stdout || known.stderr ? known : undefined;
}
