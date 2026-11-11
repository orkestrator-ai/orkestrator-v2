/**
 * Test-only shortening of the Files panel's page poll (to-do 7569 (retired), task 2),
 * so a Docker fixture spec can prove the poll pauses while the document is
 * hidden in a few seconds instead of three 5 s intervals.
 *
 * A spec sets `window.orkestratorAgentTestTiming = { filesPanelPollMs: 1000 }`
 * from an init script, before the app loads. It is honoured only in a Vite
 * dev renderer of an agent-test (`dev:test`) profile (`import.meta.env.DEV`
 * and `VITE_ORKESTRATOR_PROFILE_FLAVOR === "agent-test"`, which only the
 * agent-test launcher sets), the same gate as the scope-proof harness; a
 * production build drops the branch. A value can only shorten the poll, and
 * anything else is ignored.
 */

/** The Files panel's auto-refresh interval. */
export const FILES_PANEL_POLL_INTERVAL_MS = 5_000;

/** The shortest poll a spec may ask for. */
export const MIN_AGENT_TEST_FILES_PANEL_POLL_MS = 250;

declare global {
  interface Window {
    /** Agent-test dev renderers only; see `lib/agent-test-timing.ts`. */
    orkestratorAgentTestTiming?: { filesPanelPollMs?: unknown };
  }
}

/** The override in `value`, when it is a whole number within bounds. Exported for tests. */
export function filesPanelPollOverride(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  if (value < MIN_AGENT_TEST_FILES_PANEL_POLL_MS || value > FILES_PANEL_POLL_INTERVAL_MS) {
    return undefined;
  }
  return value;
}

/** The Files panel poll interval for this renderer. */
export function filesPanelPollIntervalMs(): number {
  if (import.meta.env.DEV && import.meta.env.VITE_ORKESTRATOR_PROFILE_FLAVOR === "agent-test") {
    const override = filesPanelPollOverride(
      typeof window === "undefined"
        ? undefined
        : window.orkestratorAgentTestTiming?.filesPanelPollMs,
    );
    if (override !== undefined) return override;
  }
  return FILES_PANEL_POLL_INTERVAL_MS;
}
