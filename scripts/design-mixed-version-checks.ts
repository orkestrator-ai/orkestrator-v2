import { mkdir, rm, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";

/** A running older backend must read a canvas or explicitly fence its record version. */
export function downgradeReadFailure(
  result: {
    ok: boolean;
    value?: { kind: string; problem?: string; canvas?: unknown };
    failure?: { code: string; message: string };
  },
  expectedCanvas?: unknown,
): string | null {
  if (!result.ok) return `${result.failure?.code}: ${result.failure?.message}`;
  if (result.value?.kind === "snapshot") {
    return expectedCanvas === undefined || isDeepStrictEqual(result.value.canvas, expectedCanvas)
      ? null
      : "canvas content changed";
  }
  if (result.value?.kind === "record-problem" && result.value.problem === "unsupported-version")
    return null;
  return `unexpected ${result.value?.kind}/${result.value?.problem}`;
}

export async function finishQualification(input: {
  reportPath: string;
  report: unknown;
  scratch: string;
  keep: boolean;
}): Promise<void> {
  try {
    if (input.reportPath) {
      await mkdir(path.dirname(input.reportPath), { recursive: true });
      await writeFile(input.reportPath, JSON.stringify(input.report, null, 2));
    }
  } finally {
    if (!input.keep) await rm(input.scratch, { recursive: true, force: true });
  }
}
