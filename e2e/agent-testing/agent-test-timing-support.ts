import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BrowserContext } from "@playwright/test";

/**
 * Test-only timing overrides for an agent-test profile (to-do 7569), so a
 * Docker fixture spec does not wait out a production period whose length it
 * is not testing.
 *
 * - Backend: `<data dir>/agent-test-fixtures/timing.json`, read by
 *   `apps/backend/src/core/agent-test-timing.ts` only in an isolated
 *   agent-test backend. A running profile picks a change up on its next read;
 *   removing the file restores the production values. Values can only
 *   shorten a period.
 * - Renderer: `window.orkestratorAgentTestTiming`, read by
 *   `apps/web/src/lib/agent-test-timing.ts` only in an agent-test Vite dev
 *   renderer, at module load, so it is set from an init script.
 */

/** `AGENT_TEST_TIMING_FILE` in `apps/backend/src/core/agent-test-timing.ts`. */
const TIMING_FILE = path.join("agent-test-fixtures", "timing.json");

export type BackendTiming = {
  /** The container tree cache bound, 500–10 000 ms (production 10 000). */
  containerTreeMaxAgeMs?: number;
  /** Reconcile ticks between web annotation collection passes, 1–100 (production 100). */
  webAnnotationGcEveryTicks?: number;
};

/**
 * Writes the profile's backend timing file and returns the values written,
 * with a function that removes it. Callers size their waits from the
 * returned values, never from assumed ones.
 */
export function setBackendTiming(
  dataDir: string,
  timing: BackendTiming,
): { timing: BackendTiming; restore: () => void } {
  const file = path.join(path.resolve(dataDir), TIMING_FILE);
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(timing)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
  return { timing: { ...timing }, restore: () => rmSync(file, { force: true }) };
}

export type RendererTiming = {
  /** The Files panel's page poll, 250–5 000 ms (production 5 000). */
  filesPanelPollMs?: number;
};

/** Sets the renderer timing for every page this context loads from now on. */
export async function setRendererTiming(
  context: BrowserContext,
  timing: RendererTiming,
): Promise<RendererTiming> {
  await context.addInitScript((value) => {
    (window as unknown as { orkestratorAgentTestTiming?: unknown }).orkestratorAgentTestTiming =
      value;
  }, timing);
  return { ...timing };
}
