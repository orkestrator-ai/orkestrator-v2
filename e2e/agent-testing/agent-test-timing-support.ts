import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BrowserContext } from "@playwright/test";

/**
 * Test-only timing overrides for an agent-test profile (to-do 7569 (retired)), so a
 * Docker fixture spec does not wait out a production period whose length it
 * is not testing.
 *
 * - Backend: `<data dir>/agent-test-fixtures/timing.json`, read by
 *   `apps/backend/src/core/agent-test-timing.ts` only in an isolated
 *   agent-test backend. A running profile picks a change up on its next read;
 *   removing the file restores the production values. Values can only
 *   shorten a period. The backend acknowledges what it applied in
 *   `timing-applied.json` beside it, echoing the revision written here
 *   ({@link appliedBackendTiming}).
 * - Renderer: `window.orkestratorAgentTestTiming`, read by
 *   `apps/web/src/lib/agent-test-timing.ts` only in an agent-test Vite dev
 *   renderer, at module load, so it is set from an init script.
 */

/** `AGENT_TEST_TIMING_FILE` in `apps/backend/src/core/agent-test-timing.ts`. */
const TIMING_FILE = path.join("agent-test-fixtures", "timing.json");
/** `AGENT_TEST_TIMING_APPLIED_FILE` in the same module. */
const TIMING_APPLIED_FILE = path.join("agent-test-fixtures", "timing-applied.json");

/** `CONTAINER_TREE_MAX_AGE_MS` in `apps/backend/src/core/diff-stats-service.ts`. */
export const PRODUCTION_CONTAINER_TREE_MAX_AGE_MS = 10_000;

export type BackendTiming = {
  /** The container tree cache bound, 500–10 000 ms (production 10 000). */
  containerTreeMaxAgeMs?: number;
  /** Reconcile ticks between web annotation collection passes, 1–100 (production 100). */
  webAnnotationGcEveryTicks?: number;
  /**
   * The period between coordinator repair passes, which close a stopped
   * worker's delegation, 1 000–60 000 ms (production 60 000). It applies
   * within a second of the file being written.
   */
  coordinatorRepairIntervalMs?: number;
};

/**
 * Writes the profile's backend timing file, tagged with a fresh revision, and
 * returns the values written with a function that removes it. These are the
 * values asked for: a wait that a longer period would invalidate is sized
 * from {@link appliedBackendTiming} instead.
 */
export function setBackendTiming(
  dataDir: string,
  timing: BackendTiming,
): { timing: BackendTiming; revision: string; restore: () => void } {
  const file = path.join(path.resolve(dataDir), TIMING_FILE);
  mkdirSync(path.dirname(file), { recursive: true });
  const revision = randomUUID();
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ ...timing, revision })}\n`, { mode: 0o600 });
  renameSync(temporary, file);
  return { timing: { ...timing }, revision, restore: () => rmSync(file, { force: true }) };
}

/**
 * The overrides the backend applied from the timing file tagged `revision`,
 * or `null` when it has not acknowledged that revision within `timeoutMs`:
 * the backend ignores the file (not an isolated agent-test backend) or has
 * not read it yet. The backend reads the file lazily, on the next read of a
 * value it overrides, so call this once that has happened. With `null`, size
 * the wait from the production value.
 */
export async function appliedBackendTiming(
  dataDir: string,
  revision: string,
  timeoutMs: number,
): Promise<BackendTiming | null> {
  const file = path.join(path.resolve(dataDir), TIMING_APPLIED_FILE);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const applied = JSON.parse(readFileSync(file, "utf8")) as {
        revision?: unknown;
        overrides?: BackendTiming;
      };
      if (applied.revision === revision) return { ...applied.overrides };
    } catch {
      // Not written yet, or replaced while being read: try again.
    }
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
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
