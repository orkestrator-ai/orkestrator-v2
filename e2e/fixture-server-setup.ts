import type { FullConfig } from "@playwright/test";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fixtureServerMode } from "./fixture-server-mode";
import {
  fixtureServerProbeIntervalMs,
  watchFixtureServer,
} from "../tests/playwright-fixture-server-watch";

// The component suite's global setup. It runs once in Playwright's runner,
// after the `webServer` is up and before any worker starts.
export default async function fixtureServerSetup(
  config: FullConfig,
): Promise<(() => Promise<void>) | undefined> {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) return undefined;
  // A build is always this run's own: the config never reuses a server for it.
  if (fixtureServerMode() === "dev") await assertFixtureServerOwner(baseURL);
  // Playwright stops watching the `webServer` once it has started, so a server
  // that exits mid-run would leave every later case failing with
  // ERR_CONNECTION_REFUSED. The watch ends the run instead, saying why
  // (tests/playwright-fixture-server-watch.ts).
  const watch = watchFixtureServer({ url: baseURL, intervalMs: fixtureServerProbeIntervalMs() });
  return async () => {
    watch.stop();
    // Repeated here, just above the summary, where the reader looks first.
    if (watch.stopReason) console.error(watch.stopReason);
  };
}

// Outside CI the dev server mode reuses whatever already listens on the fixture port, and
// every worktree uses the same port. A fixture server started by another
// checkout would then serve that checkout's sources, and the run would test
// code other than this one. Vite only serves `/@fs/` paths inside its own
// workspace, so asking for one of this checkout's files tells the two apart.
async function assertFixtureServerOwner(baseURL: string): Promise<void> {
  const fixtureEntry = realpathSync(path.join(import.meta.dirname, "fixture/main.tsx"));
  const response = await fetch(new URL(`/@fs${fixtureEntry}`, baseURL));
  if (response.ok) return;
  throw new Error(
    `The fixture server at ${baseURL} does not serve ${fixtureEntry} (HTTP ${response.status}). ` +
      "It belongs to another checkout. Stop it, or set ORKESTRATOR_E2E_PORT to a free port.",
  );
}
