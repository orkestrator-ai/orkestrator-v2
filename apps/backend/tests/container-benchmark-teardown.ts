import { promises as fs } from "node:fs";

/** Reporting must never prevent removal of the benchmark's owned resources. */
export async function benchmarkTeardown(
  report: () => Promise<void>,
  cleanup: () => Promise<void>,
): Promise<void> {
  let reportError: unknown;
  try {
    await report();
  } catch (error) {
    reportError = error;
  }
  try {
    await cleanup();
  } catch (error) {
    if (reportError === undefined) throw error;
    throw new AggregateError([reportError, error], "Benchmark report and cleanup failed");
  }
  if (reportError !== undefined) throw reportError;
}

export async function cleanupBenchmarkResources(
  docker: (args: string[]) => Promise<string>,
  owner: string,
  dataDir: string,
): Promise<void> {
  const ids = (await docker(["ps", "-aq", "--filter", `label=orkestrator-owner=${owner}`]))
    .split("\n")
    .filter(Boolean);
  if (ids.length > 0) await docker(["rm", "-f", ...ids]).catch(() => undefined);
  for (const kind of ["volume", "network"] as const) {
    const names = (await docker([kind, "ls", "-q", "--filter", `label=orkestrator-owner=${owner}`]))
      .split("\n")
      .filter(Boolean);
    if (names.length > 0) await docker([kind, "rm", ...names]).catch(() => undefined);
  }
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
}
