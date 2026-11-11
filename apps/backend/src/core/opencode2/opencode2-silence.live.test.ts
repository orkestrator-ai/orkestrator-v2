import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  startOpenCode2Fixture,
  type OpenCode2Fixture,
} from "../../../../../scripts/opencode2-steer-probe.js";
import { OpenCode2Client } from "./client.js";
import { OpenCode2Provider } from "./provider.js";

/**
 * The 2.x event monitor's silence watchdog (to-do 7559) against a real pinned
 * 2.x server, idle, with no credentials and no model calls. Run with
 * RUN_LIVE_OPENCODE2=1 and OPENCODE2_CLI_PATH set to the 2.x binary.
 *
 * 2.2.6 writes a `: heartbeat` comment on connect and every 15 s. A deadline
 * above that interval must keep one connection open; a deadline below it
 * must replace the connection, proving the abort and reconnect path on a
 * real response body.
 */
const binary = process.env.OPENCODE2_CLI_PATH?.trim();
const live = process.env.RUN_LIVE_OPENCODE2 === "1" && !!binary;
const liveTest = live ? test : test.skip;
const WATCH_MS = 34_000;

let fixture: OpenCode2Fixture | undefined;
const providers: OpenCode2Provider[] = [];

beforeAll(async () => {
  if (!live) return;
  fixture = await startOpenCode2Fixture(binary!);
}, 60_000);

afterAll(async () => {
  for (const provider of providers.splice(0)) await provider.dispose();
  await fixture?.stop();
});

/** A provider whose `/api/event` connections are counted. */
function countingProvider(monitorSilenceMs: number): { connections: () => number } {
  let connections = 0;
  const counting: typeof fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname === "/api/event") connections += 1;
      return fetch(input, init);
    },
    { preconnect: fetch.preconnect },
  );
  providers.push(
    new OpenCode2Provider(
      new OpenCode2Client({
        baseUrl: fixture!.baseUrl,
        password: fixture!.password,
        directory: fixture!.directory,
        fetch: counting,
      }),
      { monitorSilenceMs, monitorRetryMs: 50 },
    ),
  );
  return { connections: () => connections };
}

liveTest(
  "an idle stream's heartbeats keep it open past a deadline longer than their interval, and a shorter deadline replaces it",
  async () => {
    const steady = countingProvider(20_000);
    const replaced = countingProvider(5_000);
    await Bun.sleep(WATCH_MS);
    // Heartbeats at 0, 15 and 30 s: never 20 s of silence.
    expect(steady.connections()).toBe(1);
    // Each connection heartbeats on connect and then stays quiet for 15 s, so
    // a 5 s deadline replaces it about every 5 s.
    expect(replaced.connections()).toBeGreaterThanOrEqual(4);
  },
  WATCH_MS + 30_000,
);
