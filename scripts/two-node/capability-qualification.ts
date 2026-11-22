import type { CapabilityLibrary } from "@orkestrator/protocol/capability-resources-api";

import { SetupError } from "./harness.ts";

type PackageRevision = Pick<
  CapabilityLibrary["packages"][number],
  "id" | "artifactDigest" | "assignedSetupIds"
>;

export function copiesMatchRevision(copies: readonly string[], content: string): boolean {
  return copies.length > 0 && copies.every((copy) => copy.includes(content));
}

export function hasHandedOverPackage(
  library: CapabilityLibrary,
  expected: PackageRevision,
): boolean {
  const observed = library.packages.find((pkg) => pkg.id === expected.id);
  const setupIds = new Set(expected.assignedSetupIds);
  return (
    library.epoch === 2 &&
    observed?.artifactDigest === expected.artifactDigest &&
    observed.assignedSetupIds.length === setupIds.size &&
    new Set(observed.assignedSetupIds).size === setupIds.size &&
    observed.assignedSetupIds.every((id) => setupIds.has(id))
  );
}

const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;

export async function runCapabilityQualification(
  run: (signal: AbortSignal) => Promise<boolean>,
  cleanup: () => Promise<void>,
  error: (label: string, cause: unknown) => void,
): Promise<number> {
  const abort = new AbortController();
  const handlers = Object.entries(SIGNAL_EXIT_CODES).map(([name, status]) => {
    const signal = name as keyof typeof SIGNAL_EXIT_CODES;
    const handler = () => abort.abort({ signal, status });
    process.on(signal, handler);
    return { signal, handler };
  });
  let exitCode = 0;
  try {
    if (!(await run(abort.signal))) exitCode = 1;
  } catch (cause) {
    if (!abort.signal.aborted) {
      const setup = cause instanceof SetupError;
      error(setup ? "SETUP" : "ERROR", cause);
      exitCode = setup ? 2 : 1;
    }
  } finally {
    try {
      await cleanup();
    } catch (cause) {
      error("CLEANUP", cause);
      if (!exitCode) exitCode = 1;
    } finally {
      for (const { signal, handler } of handlers) process.off(signal, handler);
    }
  }
  if (abort.signal.aborted) {
    error("INTERRUPTED", abort.signal.reason.signal);
    return abort.signal.reason.status;
  }
  return exitCode;
}
