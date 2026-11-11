import { afterEach, describe, expect, test } from "bun:test";
import { waitUntil } from "../agent-provider-test-support.js";
import { manualSilenceClock, type ManualSilenceClock } from "./stream-silence.test-support.js";
import { FakeOpenCode2Server } from "./fake-server.test-support.js";
import { OpenCode2Provider } from "./provider.js";

/**
 * To-do 7559: a 2.x `/api/event` stream that stays open but goes quiet is
 * replaced, because while it counts as connected the provider may answer
 * from cache. The 2.x server's idle keepalive is a `: heartbeat` SSE comment,
 * which the event parser never surfaces, so the watchdog is fed by bytes.
 */
const SILENCE_MS = 150;

let server: FakeOpenCode2Server | undefined;
let provider: OpenCode2Provider | undefined;
afterEach(async () => {
  await provider?.dispose();
  server?.stop();
  provider = undefined;
  server = undefined;
});

function setup(clock: ManualSilenceClock) {
  server = new FakeOpenCode2Server();
  provider = new OpenCode2Provider(server.client(), {
    monitorRetryMs: 1,
    monitorSilenceMs: SILENCE_MS,
    monitorClock: clock.clock,
    // Activity answers stay cacheable for the whole test, so only a hint or a
    // dropped stream can make the provider read the server again.
    now: () => 0,
  });
  return { server, provider };
}

/**
 * Writes a heartbeat and waits until the watchdog has seen it: its chunk reads
 * the clock twice (bytes, then the heartbeat), and the first one arms the
 * deadline. The `server.connected` chunk alone reads it once and arms nothing.
 */
async function heartbeatSeen(server: FakeOpenCode2Server, clock: ManualSilenceClock) {
  const before = clock.reads;
  server.heartbeat();
  await waitUntil(() => clock.reads >= before + 2 && clock.pending() === 1);
}

const activeReads = (server: FakeOpenCode2Server) =>
  server.calls.filter((call) => call.path === "/api/session/active").length;

describe("OpenCode 2.x event monitor silence", () => {
  test("a stream that heartbeated and then went silent is replaced, and reads go to the server", async () => {
    const clock = manualSilenceClock();
    const { server, provider } = setup(clock);
    await waitUntil(() => server.eventConnections === 1);
    await heartbeatSeen(server, clock);
    expect(clock.pending()).toBe(1);

    const id = await provider.createSession("build", "x");
    await provider.send(id, "work", { requestId: "r" });
    // Read until an answer is served from cache: the send's own events have landed.
    let cached = false;
    for (let attempt = 0; attempt < 100 && !cached; attempt += 1) {
      const before = activeReads(server);
      cached = (await provider.activity(id)) === "working" && activeReads(server) === before;
      if (!cached) await Bun.sleep(5);
    }
    expect(cached).toBe(true);

    // The run ends while the stream is stalled: nothing hints the change.
    server.sessions.get(id)!.running = false;
    expect(await provider.activity(id)).toBe("working");

    clock.advance(SILENCE_MS);
    await waitUntil(() => server.eventConnections === 2);
    expect(await provider.activity(id)).toBe("idle");
  });

  test("a stream the server ends is a loss too: reads go to the server and the monitor reconnects", async () => {
    // However the server drops a subscriber (an overflow, a restart), the
    // body ends; nothing the stream missed may be answered from cache.
    const clock = manualSilenceClock();
    const { server, provider } = setup(clock);
    await waitUntil(() => server.eventConnections === 1);
    const id = await provider.createSession("build", "x");
    await provider.send(id, "work", { requestId: "r" });
    let cached = false;
    for (let attempt = 0; attempt < 100 && !cached; attempt += 1) {
      const before = activeReads(server);
      cached = (await provider.activity(id)) === "working" && activeReads(server) === before;
      if (!cached) await Bun.sleep(5);
    }
    expect(cached).toBe(true);

    server.sessions.get(id)!.running = false;
    server.endEvents();
    await waitUntil(() => server.eventConnections === 2);
    expect(await provider.activity(id)).toBe("idle");
  });

  test("regular heartbeats keep the stream open", async () => {
    const clock = manualSilenceClock();
    const { server } = setup(clock);
    await waitUntil(() => server.eventConnections === 1);
    for (let index = 0; index < 8; index += 1) {
      await heartbeatSeen(server, clock);
      clock.advance(SILENCE_MS / 3);
    }
    // Two full silence windows have passed; the deadline is still armed.
    expect(clock.pending()).toBe(1);
    expect(server.eventConnections).toBe(1);
  });

  test("events count as life once the deadline is armed", async () => {
    const clock = manualSilenceClock();
    const { server, provider } = setup(clock);
    await waitUntil(() => server.eventConnections === 1);
    await heartbeatSeen(server, clock);
    const id = await provider.createSession("build", "x");
    for (let index = 0; index < 8; index += 1) {
      const before = clock.reads;
      server.emitEvent(id, "session.text.delta", { delta: "x" }, false);
      await waitUntil(() => clock.reads > before);
      clock.advance(SILENCE_MS / 3);
    }
    expect(clock.pending()).toBe(1);
    expect(server.eventConnections).toBe(1);
  });

  test("a stream that never heartbeats gets no deadline", async () => {
    const clock = manualSilenceClock();
    const { server } = setup(clock);
    // The fake's `server.connected` frame is bytes, but not a heartbeat.
    await waitUntil(() => server.eventConnections === 1 && clock.reads > 0);
    expect(clock.pending()).toBe(0);
    clock.advance(SILENCE_MS * 4);
    await Bun.sleep(20);
    expect(server.eventConnections).toBe(1);
  });

  test("disposing the provider stops the deadline", async () => {
    const clock = manualSilenceClock();
    const { server, provider } = setup(clock);
    await waitUntil(() => server.eventConnections === 1);
    await heartbeatSeen(server, clock);
    expect(clock.pending()).toBe(1);
    await provider.dispose();
    expect(clock.pending()).toBe(0);
    clock.advance(SILENCE_MS * 2);
    await Bun.sleep(20);
    expect(server.eventConnections).toBe(1);
  });
});
