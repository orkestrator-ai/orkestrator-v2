/** Record only fixed diagnostics: command errors may contain prompts or credentials. */
export async function runWarmQualification(options: {
  failures: string[];
  run: () => Promise<void>;
  cleanup: Array<{ name: string; run: () => Promise<void> }>;
  finish: (verdict: "passed" | "failed") => Promise<void>;
}): Promise<void> {
  let completed = false;
  try {
    await options.run();
    completed = true;
  } catch (error) {
    options.failures.push("Unexpected qualification exception; see the test failure for details.");
    throw error;
  } finally {
    for (const cleanup of options.cleanup) {
      try {
        await cleanup.run();
      } catch {
        options.failures.push(`Cleanup failed: ${cleanup.name}`);
      }
    }
    await options.finish(completed && options.failures.length === 0 ? "passed" : "failed");
  }
  // A cleanup error must fail Playwright too, not just the evidence artifact.
  if (options.failures.length > 0) {
    throw new Error(options.failures.join("\n"));
  }
}

/** The caller's read scopes this to the unique server name created by this run. */
export async function removeWarmProbeDefinition(
  read: () => Promise<{ revision: string | null; definition?: { entryId: string } }>,
  remove: (entryId: string, revision: string | null) => Promise<void>,
): Promise<void> {
  const current = await read();
  if (!current.definition) return;
  await remove(current.definition.entryId, current.revision);
  if ((await read()).definition) throw new Error("Probe MCP definition remains after removal");
}
