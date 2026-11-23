import type { FullConfig } from "@playwright/test";
import {
  FIXTURE_IDENTITY_HEADER,
  FIXTURE_IDENTITY_PATH,
  fixtureDevIdentity,
} from "./fixture-server-identity";
import { fixtureServerMode, type FixtureServerMode } from "./fixture-server-mode";
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
  const mode = fixtureServerMode();
  const identity = mode === "dev" ? fixtureDevIdentity() : config.metadata.fixturePreviewIdentity;
  if (typeof identity !== "string" || !identity) {
    throw new Error("Missing fixture preview identity in the Playwright config.");
  }
  await assertFixtureServerOwner(baseURL, identity, mode);
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

// Playwright's URL readiness can be satisfied by another listener, even if
// reuse is off and that listener took the port during the build.
async function assertFixtureServerOwner(
  baseURL: string,
  identity: string,
  mode: FixtureServerMode,
): Promise<void> {
  const response = await fetch(new URL(FIXTURE_IDENTITY_PATH, baseURL), {
    method: "HEAD",
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status === 204 && response.headers.get(FIXTURE_IDENTITY_HEADER) === identity) return;
  // Keep the same collision wording as Vite so loopback-network.ts can retry
  // a build on a new port when the wrapper picked this one.
  const expected =
    mode === "dev"
      ? "the fixture dev server for this checkout"
      : "the fixture preview for this run";
  throw new Error(
    `Port ${new URL(baseURL).port} is already in use at ${baseURL}. Expected ${expected}. ` +
      "Stop the listener, or set ORKESTRATOR_E2E_PORT to a free port.",
  );
}
