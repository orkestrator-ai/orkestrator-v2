/**
 * Acceptance budgets of the push event layer (to-do 8102 task 7), measured
 * through the real gateway, push layer, native agent service and HTTP bridge
 * provider against a fake Claude bridge on a manual clock
 * (`push-acceptance-fixture.ts`; `scripts/push-acceptance.ts` prints
 * the full ten-minute table recorded in docs/architecture/push-events.md).
 *
 * Also the faults that must converge on the bridge's state through the real
 * gateway: a dropped stream, a duplicate frame, a `seq` gap and a backend
 * restart (a new push layer behind a new gateway, so a new generation).
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import { ManualClock } from "@orkestrator/protocol/testing/manual-clock";
import { NodeEventStream } from "../src/core/nodes/node-event-stream.js";
import { NodePushSubscriptionController } from "../src/core/nodes/node-push-subscriptions.js";
import { DEFAULT_NATIVE_AGENT_LIVE_WINDOW } from "@orkestrator/protocol/native-agent";
import { PUSH_KEY_THROTTLE_MS } from "@orkestrator/protocol/push-events";
import {
  AcceptanceStack,
  FakeClaudeBridge,
  SESSION,
  runScenario,
  type BridgeSignalMode,
  type ScenarioResult,
  type Viewer,
} from "./push-acceptance-fixture.js";

import { HttpBridgeProvider } from "../src/core/http-bridge/provider.js";
import { readReviewerTranscript } from "../src/core/review/reviewer-transcript.js";
import { SharedReviewTranscripts } from "../src/core/review/transcript-push.js";
import { ReviewTranscriptPushTopic } from "../src/core/push/review-transcript-push-topic.js";
import { formatReviewTranscriptPushKey } from "@orkestrator/protocol/push-events";

const stacks: AcceptanceStack[] = [];
afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.stop();
});

async function pushStack(bridge: BridgeSignalMode = "cadence"): Promise<AcceptanceStack> {
  const stack = await AcceptanceStack.start({ push: true, bridge });
  stacks.push(stack);
  stack.bridge.startTurn();
  return stack;
}

/** What a fresh read of the session answers: the authoritative tokens. */
async function authoritative(stack: AcceptanceStack) {
  const update = await stack.service.getLiveUpdate({
    ...SESSION,
    viewVersion: 1,
    liveWindow: DEFAULT_NATIVE_AGENT_LIVE_WINDOW,
  });
  return {
    transcript: "token" in update.transcript ? update.transcript.token : undefined,
    state: "token" in update.state ? update.state.token : undefined,
  };
}

async function expectConverged(stack: AcceptanceStack, viewers: readonly Viewer[]) {
  // Every cadence and the recovery poll have had their chance.
  await stack.advance(1_000);
  const truth = await authoritative(stack);
  for (const viewer of viewers) {
    expect({
      name: viewer.name,
      revision: viewer.seenRevision,
      stateMarker: viewer.stateMarker,
      transcript: viewer.transcriptToken,
      state: viewer.stateToken,
      healthy: viewer.pushHealthy(),
    }).toEqual({
      name: viewer.name,
      revision: stack.bridge.revision,
      stateMarker: 12_000 + stack.bridge.stateRevision,
      transcript: truth.transcript,
      state: truth.state,
      healthy: true,
    });
  }
}

/** The bridge moves for `ms`: the tail every 100 ms. */
async function streamFor(stack: AcceptanceStack, ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 100) {
    stack.bridge.stream();
    await stack.advance(100);
  }
}

describe("push acceptance budgets", () => {
  test("two relayed nodes share bridge reads across windows and meet the latency budget", async () => {
    const clock = new ManualClock();
    const command = await AcceptanceStack.start({ clock, push: true, bridge: "revisions" });
    stacks.push(command);
    const leaves = new Map<BackendId, AcceptanceStack>();
    for (const id of ["bk_acceptance_a", "bk_acceptance_b"] as BackendId[]) {
      const leaf = await AcceptanceStack.start({ clock, push: true, bridge: "revisions" });
      stacks.push(leaf);
      leaf.bridge.startTurn();
      leaves.set(id, leaf);
    }

    const upstreams = new Map<AcceptanceStack, { connected: boolean; bytesRead: number }>();
    let relayInvocations = 0;
    const relay = new NodePushSubscriptionController({
      timers: clock,
      leaf: {
        holdForPush: (nodeId) => {
          const leaf = leaves.get(nodeId)!;
          const upstream = { connected: false, bytesRead: leaf.eventBytesWritten() };
          upstreams.set(leaf, upstream);
          const fetchImpl: typeof fetch = Object.assign(
            async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
              const headers = new Headers(init?.headers);
              headers.set("accept-encoding", "identity");
              const response = await fetch(input, { ...init, headers });
              const body = response.body?.pipeThrough(
                new TransformStream<Uint8Array, Uint8Array>({
                  transform(chunk, controller) {
                    upstream.bytesRead += chunk.byteLength;
                    controller.enqueue(chunk);
                  },
                }),
              );
              return new Response(body, response);
            },
            { preconnect: fetch.preconnect },
          );
          const stream = new NodeEventStream({
            fetchImpl,
            transport: () => ({
              baseUrl: leaf.info.url,
              headers: { authorization: `Bearer ${leaf.info.token}` },
            }),
            prefixes: ["native-agent-session-activity"],
            onConnected: (info) => {
              upstream.connected = true;
              relay.upstreamConnected(nodeId, info.push);
            },
            onClosed: () => {
              upstream.connected = false;
              relay.upstreamClosed(nodeId);
            },
            onEvent: (event, payload) => relay.upstreamFrame(nodeId, event, payload),
          });
          stream.start();
          return () => {
            upstreams.delete(leaf);
            stream.stop();
          };
        },
        link: (nodeId) => {
          const leaf = leaves.get(nodeId);
          if (!leaf) return null;
          return {
            invoke: async <T>(command: string, args?: Record<string, unknown>) => {
              relayInvocations += 1;
              try {
                return await leaf.invoke<T>(command, args ?? {});
              } finally {
                relayInvocations -= 1;
              }
            },
          };
        },
      },
    });
    relay.attachDownstream(command.push!.hub);
    command.push!.attachNodeSubscriptions(relay);
    const advance = (ms: number) =>
      clock.advanceAsync(ms, () =>
        command.settle(
          () =>
            relayInvocations > 0 ||
            [...leaves.values()].some((leaf) => {
              const upstream = upstreams.get(leaf);
              // These leaves serve only the command node's SSE client. Wait
              // for its socket before charging the next virtual millisecond.
              return (
                leaf.hasPendingWork() ||
                (upstream !== undefined &&
                  (!upstream.connected || upstream.bytesRead < leaf.eventBytesWritten()))
              );
            }),
        ),
      );

    try {
      for (const [nodeId, leaf] of leaves) {
        await leaf.addViewer("first", { pushRoute: { command, nodeId } });
      }
      await advance(500);
      expect([...leaves.values()].every((leaf) => leaf.viewers[0]!.pushHealthy())).toBe(true);

      const measure = async () => {
        const before = new Map([...leaves].map(([id, leaf]) => [id, leaf.bridge.readCalls()]));
        for (const leaf of leaves.values()) {
          leaf.bridge.changedAt.clear();
          leaf.bridge.recording = true;
          for (const viewer of leaf.viewers) viewer.observations.length = 0;
        }
        for (let index = 0; index < 24; index += 1) {
          for (const leaf of leaves.values()) leaf.bridge.stream();
          await advance(250);
        }
        await advance(500);
        return [...leaves].map(([id, leaf]) => {
          for (const viewer of leaf.viewers) {
            expect(viewer.seenRevision).toBe(leaf.bridge.revision);
            expect(viewer.observations).toHaveLength(24);
            const delays = viewer.observations
              .map(({ virtualMs }) => virtualMs)
              .sort((a, b) => a - b);
            expect(delays[Math.ceil(delays.length * 0.95) - 1]).toBeLessThanOrEqual(250);
          }
          return leaf.bridge.readCalls() - before.get(id)!;
        });
      };

      const oneWindow = await measure();
      for (const [nodeId, leaf] of leaves) {
        await leaf.addViewer("second", { pushRoute: { command, nodeId } });
      }
      await advance(500);
      expect(
        [...leaves.values()].every((leaf) => leaf.viewers.every((viewer) => viewer.pushHealthy())),
      ).toBe(true);
      const twoWindows = await measure();
      for (const [index, calls] of twoWindows.entries()) {
        expect(calls).toBeLessThanOrEqual(oneWindow[index]! + 4);
      }
      expect(relay.metrics()).toMatchObject({ nodes: 2, heldKeys: 2, downstreamSets: 4 });
    } finally {
      relay.stop();
    }
  }, 30_000);

  test("quiet, streaming and announced workloads against the old cadence, one and two viewers", async () => {
    const scenario = {
      quietMinutes: 2,
      streamingSeconds: 10,
      announcedChanges: 6,
      announcedEveryMs: 3_000,
    };
    // `before`: no push. `cadence`: push against a bridge without revisions
    // (the observer reads at the old cadence). `revisions`: push against a
    // bridge whose observe frames carry revisions (the observer reads on them).
    const runs = {
      before: { mode: "before", bridge: "cadence" },
      cadence: { mode: "after", bridge: "cadence" },
      revisions: { mode: "after", bridge: "revisions" },
    } as const;
    const results = new Map<string, ScenarioResult>();
    for (const [name, run] of Object.entries(runs)) {
      for (const viewers of [1, 2]) {
        results.set(`${name}-${viewers}`, await runScenario({ ...scenario, ...run, viewers }));
      }
    }
    const result = (name: keyof typeof runs, viewers: number) => results.get(`${name}-${viewers}`)!;

    for (const viewers of [1, 2]) {
      const before = result("before", viewers);
      for (const name of ["cadence", "revisions"] as const) {
        const after = result(name, viewers);
        for (const [index, viewer] of after.quiet.viewers.entries()) {
          const old = before.quiet.viewers[index]!;
          // The old cadence: one live update every 500 ms while the turn runs.
          expect(old.readsPerMinute).toBe(120);
          // At least 90% fewer recurring reads, and bytes, per viewer while quiet.
          expect(viewer.readsPerMinute).toBeLessThanOrEqual(old.readsPerMinute * 0.1);
          expect(viewer.wireBytes).toBeLessThanOrEqual(old.wireBytes * 0.1);
          // What is left is the 30 s recovery poll, and it found nothing.
          expect(Object.keys(viewer.readsByReason)).toEqual(["recovery-poll"]);
          // An announced change is one read per viewer, through its push frame,
          // as under polling (where the announcement itself was the read).
          const announced = after.announced.viewers[index]!;
          expect(announced.readsByReason.activity).toBeUndefined();
          expect(announced.readsByReason["push-frame"]).toBe(scenario.announcedChanges);
          expect(before.announced.viewers[index]!.readsByReason.activity).toBe(
            scenario.announcedChanges,
          );
          // Streaming: one read per frame. On the cadence bridge that is no
          // more than polling; on a revisions bridge it follows the shared
          // throttle (the cost of the 250 ms latency target).
          const streamingReads = after.streaming.viewers[index]!;
          if (name === "cadence") {
            expect(streamingReads.reads).toBeLessThanOrEqual(
              before.streaming.viewers[index]!.reads,
            );
          } else {
            expect(streamingReads.readsPerMinute).toBeLessThanOrEqual(
              60_000 / PUSH_KEY_THROTTLE_MS + 5,
            );
          }
          expect(Object.keys(streamingReads.readsByReason)).toEqual(["push-frame"]);
        }
        for (const client of after.client) {
          expect(client).toMatchObject({ seqGaps: 0, resyncs: 0, recoveryFoundChange: {} });
        }
        // An announced change reaches the view through its frame inside the
        // coalescing window (virtual time, independent of this host's speed).
        expect(after.announced.latency.samples).toBe(scenario.announcedChanges * viewers);
        expect(after.announced.latency.virtualP95).toBeLessThanOrEqual(50);
      }
    }

    for (const name of ["cadence", "revisions"] as const) {
      // A second viewer does not add bridge reads under push; under polling it doubled them.
      for (const phase of ["quiet", "streaming"] as const) {
        expect(result(name, 2)[phase].bridgeCalls).toBeLessThanOrEqual(
          result(name, 1)[phase].bridgeCalls * 1.05 + 5,
        );
      }
    }
    for (const phase of ["quiet", "streaming"] as const) {
      expect(result("before", 2)[phase].bridgeCalls).toBeGreaterThanOrEqual(
        result("before", 1)[phase].bridgeCalls * 1.8,
      );
    }

    // A revisions bridge: a quiet running turn costs the bridge the 30 s
    // backstop and the recovery polls, not a read every 500 ms.
    expect(result("revisions", 1).quiet.bridgeCalls).toBeLessThanOrEqual(
      result("cadence", 1).quiet.bridgeCalls * 0.05,
    );
    for (const viewers of [1, 2]) {
      // A single unannounced change: the bridge's hint wakes the observer at
      // once, so the view has it inside the coalescing window...
      expect(result("revisions", viewers).sparse.latency.virtualP95).toBeLessThanOrEqual(50);
      // ...where without revisions it waits for the observer's 500 ms round.
      expect(result("cadence", viewers).sparse.latency.virtualP95).toBeGreaterThan(250);
      // A continuous stream on a revisions bridge: a delta waits at most one
      // shared spacing (PUSH_KEY_THROTTLE_MS) for the next read and frame,
      // plus the frames' 50 ms offset from the leading edge: under the 250 ms
      // p95 target.
      const streaming = result("revisions", viewers).streaming;
      expect(streaming.latency.virtualP95).toBeLessThanOrEqual(PUSH_KEY_THROTTLE_MS + 50);
      expect(streaming.latency.virtualP95).toBeLessThan(250);
      // Each frame costs one provider round however many viewers read after
      // it: their reads take the observer's settled answer (a hint no longer
      // drops it).
      const frames = streaming.viewers[0]!.pushFrames;
      expect(streaming.bridgeRoutes["GET /session/:id/transcript"]).toBeLessThanOrEqual(frames + 1);
      // Without revisions the observer's 500 ms cadence still bounds it.
      expect(result("cadence", viewers).streaming.latency.virtualP95).toBeLessThanOrEqual(550);
    }
    expect(result("before", 1).streaming.latency.virtualP95).toBeLessThanOrEqual(500);
  }, 180_000);
});

describe("push faults through the real gateway converge on the bridge's state", () => {
  test("a dropped stream falls back to the old cadence, re-subscribes and catches up", async () => {
    const stack = await pushStack();
    const steady = await stack.addViewer("steady");
    const dropped = await stack.addViewer("dropped");
    await stack.advance(2_000);
    expect(dropped.pushHealthy()).toBe(true);

    dropped.disconnect();
    await stack.advance(10);
    expect(dropped.pushHealthy()).toBe(false);
    const pollsBefore = dropped.counters.readsByReason.poll ?? 0;
    await streamFor(stack, 3_000);
    stack.bridge.moveState();
    // While the stream is down the view polls at its old 500 ms cadence.
    expect((dropped.counters.readsByReason.poll ?? 0) - pollsBefore).toBeGreaterThanOrEqual(5);

    await dropped.connect();
    await streamFor(stack, 1_000);
    expect(dropped.diagnostics().setCalls).toBeGreaterThanOrEqual(2);
    await expectConverged(stack, [steady, dropped]);
  });

  test("a duplicate frame is ignored and a seq gap re-subscribes, without a lost change", async () => {
    const stack = await pushStack();
    const steady = await stack.addViewer("steady");
    // seq 1 is the subscription's first authoritative answer; 2.. are changes.
    const lossy = await stack.addViewer("lossy", {
      duplicateSeq: new Set([3]),
      dropSeq: new Set([5]),
    });
    await stack.advance(2_000);
    await streamFor(stack, 5_000);
    stack.bridge.moveState();
    await streamFor(stack, 1_000);

    const diagnostics = lossy.diagnostics();
    expect(diagnostics.duplicateFrames).toBe(1);
    expect(diagnostics.seqGaps).toBe(1);
    // The gap re-sent the set; its answer named the move, so the view read.
    expect(diagnostics.setCalls).toBe(2);
    expect(lossy.counters.readsByReason["push-resubscribed"] ?? 0).toBeLessThanOrEqual(1);
    // The duplicate cost no read: one read per frame applied.
    expect(lossy.counters.readsByReason["push-frame"]).toBeLessThanOrEqual(
      diagnostics.framesReceived,
    );
    expect(steady.diagnostics()).toMatchObject({ duplicateFrames: 0, seqGaps: 0 });
    await expectConverged(stack, [steady, lossy]);
  });

  test.each(["cadence", "revisions"] as const)(
    "a backend restart (a new push layer, so a new generation) converges, %s bridge",
    async (bridge) => {
      const stack = await pushStack(bridge);
      const a = await stack.addViewer("a");
      const b = await stack.addViewer("b");
      await stack.advance(2_000);
      await streamFor(stack, 2_000);
      const firstGeneration = a.setAnswers.at(-1)!;
      expect(firstGeneration).toMatchObject({ status: "applied" });

      const oldPush = stack.push!;
      await stack.restartBackend(() => {
        // The bridge keeps running while the backend is away.
        for (let tick = 0; tick < 5; tick += 1) stack.bridge.stream();
        stack.bridge.moveState();
      });
      expect(oldPush.metrics()).toMatchObject({ connections: 0, observedKeysByTopic: {} });
      await streamFor(stack, 2_000);

      const generationOf = (viewer: Viewer, index: number) => {
        const answer = viewer.setAnswers[index];
        const subscription = answer?.status === "applied" ? answer.subscriptions[0] : undefined;
        return subscription?.status === "ok" ? subscription.generation : undefined;
      };
      for (const viewer of [a, b]) {
        const before = generationOf(viewer, 0);
        const after = generationOf(viewer, viewer.setAnswers.length - 1);
        expect(before).toBeString();
        expect(after).toBeString();
        expect(after).not.toBe(before);
      }
      expect(stack.push!.metrics().topics["native-session"].observers).toBe(1);
      if (bridge === "revisions") {
        // The new backend's observer reads on the bridge's hints again.
        expect(stack.push!.metrics().topics["native-session"].bridgeObservers).toBe(1);
      }
      await expectConverged(stack, [a, b]);
    },
  );
});

test("large tool locator ranges cross the provider hop without shipping the full detail", async () => {
  const stack = await pushStack("revisions");
  const initial = "first line\n" + "x".repeat(200_000);
  stack.bridge.writeToolOutput(initial);
  await authoritative(stack);
  const first = await stack.readToolOutput("tail");
  if (first.status !== "ok") throw new Error(`Tool output: ${first.status}`);
  expect(first.totalBytes).toBe(initial.length);
  expect(stack.bridge.routeCounts()["GET /session/:id/transcript/detail"]).toBeUndefined();
  expect(stack.bridge.outputResponseBytes).toBeLessThan(4_600);

  const before = stack.bridge.outputResponseBytes;
  stack.bridge.writeToolOutput(initial + "final line");
  await authoritative(stack);
  const range = await stack.readToolOutput("range", first.end, first.endAnchor);
  expect(range).toMatchObject({
    status: "ok",
    text: "final line",
    totalBytes: initial.length + 10,
  });
  expect(stack.bridge.outputResponseBytes - before).toBeLessThan(512);
});

test.each(["revisions", "cadence"] as const)(
  "two reviewer viewers share real bridge transcript work in %s mode",
  async (mode) => {
    const clock = new ManualClock();
    const bridge = new FakeClaudeBridge(() => clock.now(), mode);
    bridge.startTurn();
    const shared = new SharedReviewTranscripts(() => clock.now());
    const identity = {
      environmentId: "review-env",
      agent: "claude",
      providerSessionId: "provider-session",
      view: "reviewer",
    };
    const key = formatReviewTranscriptPushKey({ workflowId: "workflow", reviewerId: "reviewer" });
    const provider = new HttpBridgeProvider(
      { agent: "claude", baseUrl: "http://acceptance-bridge.invalid", authToken: "acceptance" },
      bridge.fetch,
    );
    const load = (token?: string) =>
      readReviewerTranscript(provider, identity.providerSessionId, token);
    const read = (token?: string, probe = false) => shared.read(identity, token, probe, load);
    const published: string[] = [];
    const topic = new ReviewTranscriptPushTopic({
      timers: clock,
      now: () => clock.now(),
      readTarget: async () => ({ ...identity, live: true, digest: "same" }),
      bridgeAnnounces: () => mode === "revisions",
      probeTranscript: async (_key, token) => (await read(token, true)).sourceToken,
      publish: (_key, _stamp, parts) => published.push(...parts),
    });
    const calls = () => bridge.routeCounts()["GET /session/:id/transcript"] ?? 0;
    try {
      const mounted = await read();
      expect(calls()).toBe(1);
      topic.retain(key);
      await topic.resolve(key);

      bridge.stream();
      if (mode === "revisions") {
        shared.invalidate(identity.environmentId, identity.agent, identity.providerSessionId);
        topic.hint(identity.environmentId, identity.agent, identity.providerSessionId, [
          "transcript",
        ]);
      } else {
        await clock.advanceAsync(0);
      }
      expect(published).toEqual(["transcript"]);
      const [first, second] = await Promise.all([read(mounted.sourceToken), read()]);
      expect(first.kind).toBe("snapshot");
      expect(second).toEqual(first);
      expect(first.sourceToken).not.toBe(mounted.sourceToken);
      expect(calls()).toBe(2);
      expect(await read(first.sourceToken)).toMatchObject({ kind: "unchanged" });
      expect(calls()).toBe(2);
    } finally {
      topic.dispose();
      await provider.dispose();
    }
  },
);
