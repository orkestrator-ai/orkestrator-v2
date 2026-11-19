/**
 * Thirty minutes of noisy output through the real gateway to a slow consumer
 * on a real socket (to-do 8102 task 7; push-hub.test.ts has the same budget
 * against a manually backpressured sink).
 *
 * A running session streams all the way through while 192 KiB/s of other
 * authoritative events share each viewer's event stream. The slow viewer
 * stops reading its socket for 40 s of every minute, so the kernel buffers
 * fill and the gateway's own queue for it passes the 1 MiB soft limit, where
 * push changes wait in the hub's coalescing map. Every five minutes the slow
 * view closes and another opens. A fast viewer reads throughout.
 *
 * Measured: the slow socket's peak queued bytes at the gateway, the hub's peak
 * pending entries and bytes, the heap after each view cycle, and that nothing
 * is retained once the views close. Both viewers end on the bridge's state.
 * `PUSH_ACCEPTANCE_REPORT=<file>` writes the measured figures there.
 *
 * Slow tier: real sockets carry about 700 MB, so it takes tens of seconds.
 */
import { afterEach, expect, test } from "bun:test";
import { DEFAULT_NATIVE_AGENT_LIVE_WINDOW } from "@orkestrator/protocol/native-agent";
import { TOOL_OUTPUT_PUSH_TOPIC, formatToolOutputPushKey } from "@orkestrator/protocol/push-events";
import { AcceptanceStack, SESSION, TOOL_CALL_ID, type Viewer } from "./push-acceptance-fixture.js";

const SOFT_LIMIT = 1024 * 1024;
const HARD_LIMIT = 8 * 1024 * 1024;

const stacks: AcceptanceStack[] = [];
afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.stop();
});

function heapUsed(): number {
  Bun.gc(true);
  return process.memoryUsage().heapUsed;
}

test("a slow real-socket consumer over thirty noisy minutes keeps every queue bounded and leaves nothing behind", async () => {
  const stack = await AcceptanceStack.start({ push: true });
  stacks.push(stack);
  stack.bridge.startTurn();
  const noise = { blob: "n".repeat(16 * 1024) };
  const fast = await stack.addViewer("fast");
  let slow = await stack.addViewer("slow-0");
  await stack.advance(2_000);

  let peakQueued = 0;
  let peakPendingEntries = 0;
  let peakPendingBytes = 0;
  let fastFramesWhilePaused = 0;
  const heap: number[] = [heapUsed()];
  const closeView = (viewer: Viewer) => {
    viewer.close();
    stack.viewers.splice(stack.viewers.indexOf(viewer), 1);
    stack.writers.delete(viewer);
  };

  for (let second = 0; second < 30 * 60; second += 1) {
    if (second > 0 && second % 300 === 0) {
      // A view closes and another opens (a tab switch, a window closed).
      slow.resumeStream();
      await stack.advance(1_000);
      closeView(slow);
      await stack.settle();
      heap.push(heapUsed());
      slow = await stack.addViewer(`slow-${second}`);
    }
    const inMinute = second % 60;
    if (inMinute === 0) slow.pauseStream();
    if (inMinute === 40) slow.resumeStream();
    const fastFrames = fast.counters.pushFrames;
    for (let half = 0; half < 2; half += 1) {
      stack.bridge.stream();
      for (let index = 0; index < 6; index += 1) stack.emitBackendEvent("fixture-noise", noise);
      await stack.advance(500);
    }
    if (inMinute < 40) fastFramesWhilePaused += fast.counters.pushFrames - fastFrames;
    const metrics = stack.push!.metrics();
    peakQueued = Math.max(peakQueued, slow.queuedBytes());
    peakPendingEntries = Math.max(peakPendingEntries, metrics.pendingEntries);
    peakPendingBytes = Math.max(peakPendingBytes, metrics.pendingBytes);
  }
  slow.resumeStream();
  stack.bridge.moveState();
  await stack.advance(2_000);

  const metrics = stack.push!.metrics();
  const measured = {
    peakQueuedBytes: peakQueued,
    peakPendingEntries,
    peakPendingBytes,
    backpressureHolds: metrics.backpressureHolds,
    framesSent: metrics.framesSent,
    changesCoalesced: metrics.changesCoalesced,
    resyncs: metrics.resyncsByReason,
    fastFramesWhilePaused,
  };
  // The slow socket really backed up past the soft limit, and push held its
  // changes in the map instead of queueing frames behind the noise.
  expect(peakQueued).toBeGreaterThan(SOFT_LIMIT);
  expect(peakQueued).toBeLessThan(HARD_LIMIT);
  expect(metrics.backpressureHolds).toBeGreaterThan(0);
  // One session, so at most one pending entry per connection.
  expect(peakPendingEntries).toBeLessThanOrEqual(2);
  expect(peakPendingBytes).toBeLessThan(4 * 1024);
  // A slow consumer never held up the fast one.
  expect(fastFramesWhilePaused).toBeGreaterThan(30 * 40);

  // Both end on the bridge's state.
  const update = await stack.service.getLiveUpdate({
    ...SESSION,
    viewVersion: 1,
    liveWindow: DEFAULT_NATIVE_AGENT_LIVE_WINDOW,
  });
  for (const viewer of [fast, slow]) {
    expect(viewer.seenRevision).toBe(stack.bridge.revision);
    expect(viewer.stateMarker).toBe(12_000 + stack.bridge.stateRevision);
    expect(viewer.transcriptToken).toBe(
      "token" in update.transcript ? update.transcript.token : "",
    );
  }

  // Nothing is retained once the views close.
  closeView(slow);
  closeView(fast);
  await stack.settle();
  heap.push(heapUsed());
  expect(stack.push!.metrics()).toMatchObject({
    connections: 0,
    pendingEntries: 0,
    pendingBytes: 0,
    observedKeysByTopic: {},
    topics: { "native-session": { observers: 0 } },
  });
  expect(stack.eventWriters().size).toBe(0);
  // No growth from view cycle to view cycle: the last cycles sit within a
  // small margin of the first ones (the replay ring and caches are bounded).
  const report = process.env.PUSH_ACCEPTANCE_REPORT;
  if (report) {
    const mib = (bytes: number) => Math.round(bytes / 104_857.6) / 10;
    await Bun.write(
      report,
      JSON.stringify({ ...measured, heapAfterEachViewCycleMiB: heap.map(mib) }, null, 2),
    );
  }
  const early = Math.max(heap[1]!, heap[2]!);
  const late = Math.max(...heap.slice(-3));
  expect(late - early).toBeLessThan(16 * 1024 * 1024);
}, 300_000);

test("expanded tool ranges converge under real socket backpressure across repeated view closes", async () => {
  const stack = await AcceptanceStack.start({ push: true, bridge: "revisions" });
  stacks.push(stack);
  stack.bridge.startTurn();
  const key = formatToolOutputPushKey({ ...SESSION, toolUseId: TOOL_CALL_ID });
  const noise = { blob: "n".repeat(16 * 1024) };
  let output = "start";
  stack.bridge.writeToolOutput(output);
  for (let cycle = 0; cycle < 3; cycle += 1) {
    const view = await stack.addViewer(`range-${cycle}`);
    const tail = await stack.readToolOutput("tail");
    if (tail.status !== "ok") throw new Error(`initial tail: ${tail.status}`);
    let end = tail.end;
    let anchor = tail.endAnchor;
    let appended = "";
    let reads = 0;
    let reading: Promise<void> | null = null;
    let failure: unknown;
    let dirty = false;
    const readAvailable = async () => {
      do {
        dirty = false;
        const range = await stack.readToolOutput("range", end, anchor);
        if (range.status !== "ok" || range.reset) throw new Error("expected a continuous range");
        reads += 1;
        appended += range.text;
        end = range.end;
        anchor = range.endAnchor;
        dirty ||= end < range.totalBytes;
      } while (dirty);
    };
    const unsubscribe = view.client.subscribe(TOOL_OUTPUT_PUSH_TOPIC, key, () => {
      dirty = true;
      if (reading) return;
      view.inFlight += 1;
      reading = readAvailable().finally(() => {
        reading = null;
        view.inFlight -= 1;
      });
      void reading.catch((error: unknown) => {
        failure ??= error;
      });
    });
    await stack.advance(500);
    expect(view.client.isHealthy(TOOL_OUTPUT_PUSH_TOPIC, key)).toBe(true);
    const start = output.length;
    view.pauseStream();
    for (let step = 0; step < 45; step += 1) {
      output += `chunk-${cycle}-${step}:${"x".repeat(256)}\n`;
      stack.bridge.writeToolOutput(output);
      for (let i = 0; i < 12; i += 1) stack.emitBackendEvent("fixture-noise", noise);
      await stack.advance(1_000);
    }
    expect(view.queuedBytes()).toBeGreaterThan(SOFT_LIMIT);
    expect(stack.push!.metrics().pendingEntries).toBeLessThanOrEqual(2);
    expect(stack.push!.toolOutputs.metrics().changes).toBeGreaterThan(0);
    expect(await stack.readToolOutput("tail")).toMatchObject({ totalBytes: output.length });
    view.resumeStream();
    await stack.advance(2_000);
    await reading;
    expect(failure).toBeUndefined();
    expect(end).toBe(output.length);
    expect(appended).toBe(output.slice(start));
    expect(reads).toBeGreaterThan(1);
    unsubscribe();
    view.close();
    stack.viewers.splice(stack.viewers.indexOf(view), 1);
    stack.writers.delete(view);
    await stack.advance(500);
    expect(stack.push!.metrics()).toMatchObject({
      connections: 0,
      pendingEntries: 0,
      topics: { "tool-output": { watches: 0, holding: 0 } },
    });
  }
}, 120_000);
