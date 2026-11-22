import { writeFile } from "node:fs/promises";
import { MAX_ARTIFACT_TREE_BYTES, MAX_SANITIZABLE_FILE_BYTES } from "./artifact-sanitizer";

// Reserve a full file's worth for the evidence, reporter and other suite artifacts.
const MAX_TRACE_CELLS = Math.floor(MAX_ARTIFACT_TREE_BYTES / MAX_SANITIZABLE_FILE_BYTES) - 1;
const MAX_TRACE_KEYS = 200;

export function traceSelection(
  variants: string | undefined,
  rounds: string | number | undefined,
  keys: number,
  parseRounds: (rounds: string | number) => number,
) {
  const selection = { variants: variants ?? "idle", rounds: parseRounds(rounds ?? 1) };
  if (
    selection.variants.split(",").length * selection.rounds > MAX_TRACE_CELLS ||
    keys > MAX_TRACE_KEYS
  ) {
    throw new Error(
      `ORKESTRATOR_AGENT_TEST_ECHO_TRACE supports at most ${MAX_TRACE_CELLS} cells (variants × rounds) and ${MAX_TRACE_KEYS} keys per cell`,
    );
  }
  return selection;
}

/** Trace and optional CPU profile share one file budget per traced cell. */
export function traceCellArtifacts() {
  let remaining = MAX_SANITIZABLE_FILE_BYTES;
  return async (file: string, contents: Buffer | string) => {
    const bytes = Buffer.byteLength(contents);
    if (bytes > remaining) {
      throw new Error(
        "Echo capture exceeds its per-cell byte budget. Reduce ORKESTRATOR_AGENT_TEST_ECHO_KEYS.",
      );
    }
    await writeFile(file, contents);
    remaining -= bytes;
  };
}
