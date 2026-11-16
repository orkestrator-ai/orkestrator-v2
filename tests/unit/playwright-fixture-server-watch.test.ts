import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { fakePid } from "@orkestrator/protocol/testing/fake-pids";
import {
  FIXTURE_SERVER_PROBE_INTERVAL_ENV,
  FIXTURE_SERVER_PROBE_INTERVAL_MS,
  FIXTURE_SERVER_REFUSALS_BEFORE_STOP,
  classifyProbeError,
  fixtureServerProbeIntervalMs,
  probeFixtureServer,
  watchFixtureServer,
  type FixtureProbeResult,
  type FixtureServerWatch,
} from "../playwright-fixture-server-watch";

// The real path, a Playwright run of the component suite's config whose
// fixture server exits mid-run, is in
// playwright-fixture-server-exit.integration.test.ts.

const PID = fakePid(1);
const URL_UNDER_TEST = "http://127.0.0.1:1422";

const watches: FixtureServerWatch[] = [];
afterEach(() => {
  for (const watch of watches.splice(0)) watch.stop();
});

function harness(options: { sigintListeners?: number; results: FixtureProbeResult[] }) {
  const calls: string[] = [];
  const lines: string[] = [];
  const timers: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
  const pending = [...options.results];
  let probes = 0;
  const watch = watchFixtureServer({
    url: URL_UNDER_TEST,
    probe: async (url, timeoutMs) => {
      probes += 1;
      calls.push(`probe ${url} ${timeoutMs}`);
      return pending.shift() ?? { outcome: "up" };
    },
    log: (line) => lines.push(line),
    target: {
      pid: PID,
      listenerCount: () => options.sigintListeners ?? 1,
      kill: (pid, signal) => calls.push(`kill ${pid} ${signal}`),
    },
    setInterval: (callback, ms) => {
      const timer = { callback, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearInterval: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
  });
  watches.push(watch);
  const tick = async (count = 1) => {
    for (let index = 0; index < count; index += 1) {
      const timer = timers[0]!;
      if (!timer.cleared) timer.callback();
      // Let the probe and its result settle before the next tick.
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    }
  };
  return { watch, calls, lines, timers, tick, probes: () => probes };
}

const REFUSED: FixtureProbeResult = { outcome: "refused", detail: "ECONNREFUSED" };

describe("watchFixtureServer", () => {
  test("probes every interval with that interval as the deadline", async () => {
    const run = harness({ results: [] });
    expect(run.timers).toHaveLength(1);
    expect(run.timers[0]!.ms).toBe(FIXTURE_SERVER_PROBE_INTERVAL_MS);
    await run.tick(2);
    expect(run.calls).toEqual([
      `probe ${URL_UNDER_TEST} ${FIXTURE_SERVER_PROBE_INTERVAL_MS}`,
      `probe ${URL_UNDER_TEST} ${FIXTURE_SERVER_PROBE_INTERVAL_MS}`,
    ]);
  });

  test("stops the run with one line after consecutive refusals", async () => {
    const run = harness({ results: [REFUSED, REFUSED, REFUSED] });
    await run.tick(FIXTURE_SERVER_REFUSALS_BEFORE_STOP - 1);
    expect(run.calls.filter((call) => call.startsWith("kill"))).toEqual([]);
    expect(run.lines).toEqual([]);

    await run.tick();
    expect(run.calls.at(-1)).toBe(`kill ${PID} SIGINT`);
    expect(run.lines).toHaveLength(1);
    expect(run.lines[0]).toContain(`The fixture server at ${URL_UNDER_TEST} stopped answering`);
    expect(run.lines[0]).toContain("ECONNREFUSED");
    expect(run.lines[0]).toContain("net::ERR_CONNECTION_REFUSED");
    expect(run.watch.stopReason).toBe(run.lines[0]);
    // It stops probing once it has stopped the run.
    expect(run.timers[0]!.cleared).toBe(true);
    const probes = run.probes();
    await run.tick(3);
    expect(run.probes()).toBe(probes);
    expect(run.calls.filter((call) => call.startsWith("kill"))).toHaveLength(1);
  });

  test("an answer clears the tally", async () => {
    const run = harness({ results: [REFUSED, REFUSED, { outcome: "up" }, REFUSED, REFUSED] });
    await run.tick(5);
    expect(run.calls.some((call) => call.startsWith("kill"))).toBe(false);
    expect(run.watch.stopReason).toBeUndefined();
  });

  test("a probe with no answer in time neither counts nor clears", async () => {
    const run = harness({
      results: [
        REFUSED,
        { outcome: "inconclusive" },
        { outcome: "inconclusive" },
        REFUSED,
        REFUSED,
      ],
    });
    await run.tick(3);
    expect(run.watch.stopReason).toBeUndefined();
    await run.tick(1);
    expect(run.watch.stopReason).toBeUndefined();
    await run.tick(1);
    // The third refusal, with the inconclusive probes between them ignored.
    expect(run.watch.stopReason).toBeDefined();
  });

  test("does not signal a runner that is no longer listening for SIGINT", async () => {
    const run = harness({ sigintListeners: 0, results: [REFUSED, REFUSED, REFUSED] });
    await run.tick(3);
    expect(run.lines).toHaveLength(1);
    expect(run.calls.some((call) => call.startsWith("kill"))).toBe(false);
  });

  test("stop ends probing and is idempotent", async () => {
    const run = harness({ results: [REFUSED, REFUSED, REFUSED] });
    run.watch.stop();
    run.watch.stop();
    expect(run.timers[0]!.cleared).toBe(true);
    await run.tick(3);
    expect(run.probes()).toBe(0);
    expect(run.watch.stopReason).toBeUndefined();
  });

  test("skips a tick while the previous probe is still out", async () => {
    let release: (result: FixtureProbeResult) => void = () => {};
    let probes = 0;
    let timer: (() => void) | undefined;
    const watch = watchFixtureServer({
      url: URL_UNDER_TEST,
      probe: () => {
        probes += 1;
        return new Promise((resolve) => (release = resolve));
      },
      log: () => {},
      target: { pid: PID, listenerCount: () => 1, kill: () => {} },
      setInterval: (callback) => (timer = callback),
      clearInterval: () => {},
    });
    watches.push(watch);
    timer!();
    timer!();
    expect(probes).toBe(1);
    release({ outcome: "up" });
    await Promise.resolve();
    await Promise.resolve();
    timer!();
    expect(probes).toBe(2);
  });
});

/** A node:http server: Bun.serve would need Bun's Response, which the DOM preload replaces. */
async function listen(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe("probeFixtureServer", () => {
  // The root suite's DOM preload replaces the global fetch and AbortSignal
  // with happy-dom's, which apply a page's CORS rules and which Bun's own
  // fetch does not accept; the runner calls Node's. The deadline itself is
  // covered by classifyProbeError below.
  const runtimeFetch = ((url: string, init?: RequestInit) =>
    Bun.fetch(url, { ...init, signal: undefined })) as typeof fetch;

  test("any HTTP answer means the server is up", async () => {
    const server = await listen((_request, response) => {
      response.writeHead(500).end("gone");
    });
    try {
      expect(await probeFixtureServer(server.url, 5_000, runtimeFetch)).toEqual({ outcome: "up" });
    } finally {
      await server.close();
    }
  });

  test("a closed port is a refusal", async () => {
    const server = await listen((_request, response) => response.end());
    await server.close();
    const result = await probeFixtureServer(server.url, 5_000, runtimeFetch);
    expect(result.outcome).toBe("refused");
  });

  test("sorts errors the way Node's and Bun's fetch report them", () => {
    const nodeRefusal = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1422"), {
        code: "ECONNREFUSED",
      }),
    });
    expect(classifyProbeError(nodeRefusal)).toEqual({
      outcome: "refused",
      detail: "ECONNREFUSED",
    });
    const bunRefusal = Object.assign(new Error("Unable to connect"), {
      code: "ConnectionRefused",
    });
    expect(classifyProbeError(bunRefusal)).toEqual({
      outcome: "refused",
      detail: "ConnectionRefused",
    });
    expect(classifyProbeError(new DOMException("timed out", "TimeoutError"))).toEqual({
      outcome: "inconclusive",
    });
    expect(classifyProbeError(new DOMException("aborted", "AbortError"))).toEqual({
      outcome: "inconclusive",
    });
  });
});

describe("fixtureServerProbeIntervalMs", () => {
  test("defaults, and accepts a test override", () => {
    expect(fixtureServerProbeIntervalMs({})).toBe(FIXTURE_SERVER_PROBE_INTERVAL_MS);
    expect(fixtureServerProbeIntervalMs({ [FIXTURE_SERVER_PROBE_INTERVAL_ENV]: "250" })).toBe(250);
  });

  test("refuses an override that is not a sensible interval", () => {
    for (const raw of ["0", "50", "soon", "-5"]) {
      expect(() =>
        fixtureServerProbeIntervalMs({ [FIXTURE_SERVER_PROBE_INTERVAL_ENV]: raw }),
      ).toThrow(FIXTURE_SERVER_PROBE_INTERVAL_ENV);
    }
  });
});
