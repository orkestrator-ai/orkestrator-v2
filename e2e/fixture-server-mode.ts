/**
 * How the component suite serves its fixture page (`e2e/fixture`), read by
 * both the Playwright config and its global setup.
 *
 * - `build` (the default): a fresh development build of the fixture, made at
 *   the start of the run and served statically. A page load fetches a few
 *   hundred chunks instead of the dev server's ~1,900 modules.
 * - `dev`: Vite's dev server, as the suite used before. Reused across runs
 *   outside CI, so it suits iterating on a fixture with hot reload.
 */
export type FixtureServerMode = "build" | "dev";

export const FIXTURE_SERVER_ENV = "ORKESTRATOR_E2E_FIXTURE_SERVER";

export function fixtureServerMode(env: NodeJS.ProcessEnv = process.env): FixtureServerMode {
  const mode = env[FIXTURE_SERVER_ENV] || "build";
  if (mode !== "build" && mode !== "dev") {
    throw new Error(`Unsupported ${FIXTURE_SERVER_ENV}: ${mode} (expected "build" or "dev")`);
  }
  return mode;
}
