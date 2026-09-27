/**
 * Progress probes against the real HTTP bridge provider and the shared bridge
 * envelopes: what crosses the wire for an unchanged, a churned and a moved
 * session, and when the legacy whole-history route is (and is not) touched.
 */
import { expect, test } from "bun:test";
import { bridgeTranscriptSummaryUpdate } from "@orkestrator/protocol/bridge-transcript-summary";
import { bridgeTranscriptUpdate } from "@orkestrator/protocol/progressive-transcript";
import { codexConnection, httpProvider } from "./agent-provider-test-support.js";
import { MultiReviewProgressTracker } from "./multi-review-progress.js";
import {
  PROGRESS_SNAPSHOT_TARGET_BYTES,
  readTranscriptProgressSample,
} from "./transcript-progress.js";

function transcript(output: string) {
  return [
    { id: "prompt", role: "user", content: "review", parts: [], createdAt: "2026-09-27T00:00:00Z" },
    {
      id: "m1",
      role: "assistant",
      content: "",
      parts: [
        {
          type: "tool-invocation",
          content: "Task",
          sourcePartId: "m1:0",
          toolUseId: "task",
          childTools: [
            {
              type: "tool-invocation",
              content: "Bash",
              sourcePartId: "m1:0:child",
              toolUseId: "child",
              toolOutput: output,
            },
          ],
        },
      ],
      createdAt: "2026-09-27T00:00:00Z",
    },
  ];
}

/** A bridge whose revision advances for any change, content or not. */
function bridge(mode: "v2" | "v1" | "legacy", output = "x".repeat(700 * 1024)) {
  const state = { messages: transcript(output), revision: 1 };
  const legacyReads: string[] = [];
  const bodies: number[] = [];
  const { provider, requests } = httpProvider((url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/messages")) {
      legacyReads.push(parsed.pathname);
      return Response.json({ messages: state.messages });
    }
    if (parsed.pathname.endsWith("/transcript")) {
      if (mode === "legacy") return new Response("", { status: 404 });
      const options = {
        sessionIdentity: "session-1",
        generation: "g",
        contentEpoch: 1,
        revision: state.revision,
        complete: true,
        limit: Number(parsed.searchParams.get("limit")),
        targetBytes: Number(parsed.searchParams.get("targetBytes")),
        knownToken: parsed.searchParams.get("knownToken") ?? undefined,
      };
      const body = JSON.stringify(
        mode === "v2" && parsed.searchParams.get("version") === "2"
          ? bridgeTranscriptSummaryUpdate(state.messages, { ...options, pages: true })
          : bridgeTranscriptUpdate(state.messages as never, options),
      );
      bodies.push(body.length);
      return new Response(body, { headers: { "content-type": "application/json" } });
    }
    return new Response("", { status: 404 });
  }, codexConnection);
  let now = 0;
  const tracker = new MultiReviewProgressTracker(1_000, () => now);
  const observe = () => {
    now += 1_000;
    return tracker.observe("session-1", (known) =>
      readTranscriptProgressSample({ provider, sessionId: "session-1", known }),
    );
  };
  return { state, legacyReads, bodies, requests, observe };
}

for (const mode of ["v2", "v1"] as const) {
  test(`${mode}: unchanged probes cost no body and no legacy history read`, async () => {
    const fake = bridge(mode, "small output");
    await expect(fake.observe()).resolves.toMatchObject({ baselineEstablished: true });
    await expect(fake.observe()).resolves.toMatchObject({ probed: true, changed: false });
    expect(fake.bodies[1]).toBeLessThan(512);
    const lastUrl = new URL(fake.requests.at(-1)!.url);
    expect(lastUrl.searchParams.get("limit")).toBe("1");
    expect(lastUrl.searchParams.get("knownToken")).toBeTruthy();

    // Revision churn (usage, access time) with identical content.
    fake.state.revision += 1;
    await expect(fake.observe()).resolves.toMatchObject({ probed: true, changed: false });
    fake.state.messages = transcript("small output, then more");
    fake.state.revision += 1;
    await expect(fake.observe()).resolves.toMatchObject({ probed: true, changed: true });
    expect(fake.legacyReads).toEqual([]);
  });
}

test("v2: a nested child tool output change is progress without shipping the body", async () => {
  const fake = bridge("v2");
  await fake.observe();
  // The first sample is bounded well below the 700 KiB tool body.
  expect(fake.bodies[0]).toBeLessThan(16 * 1024);
  await expect(fake.observe()).resolves.toMatchObject({ probed: true, changed: false });
  fake.state.revision += 1;
  await expect(fake.observe()).resolves.toMatchObject({ probed: true, changed: false });
  fake.state.messages = transcript(`${"x".repeat(700 * 1024)} and one more line`);
  fake.state.revision += 1;
  await expect(fake.observe()).resolves.toMatchObject({ probed: true, changed: true });
  expect(Math.max(...fake.bodies)).toBeLessThan(16 * 1024);
  expect(fake.legacyReads).toEqual([]);
});

test("v1: a raw tail cut by the byte target is completed only when the source moved", async () => {
  const fake = bridge("v1");
  await expect(fake.observe()).resolves.toMatchObject({ baselineEstablished: true });
  expect(fake.bodies[0]).toBeLessThan(PROGRESS_SNAPSHOT_TARGET_BYTES + 4 * 1024);
  // The oversized sub-agent part was cut, so the exact tail completed it.
  expect(fake.legacyReads).toHaveLength(1);

  // Unchanged: nothing beyond a tiny conditional answer.
  await expect(fake.observe()).resolves.toMatchObject({ probed: true, changed: false });
  expect(fake.legacyReads).toHaveLength(1);

  // Churn: completed again, and the identical exact tail is not progress.
  fake.state.revision += 1;
  await expect(fake.observe()).resolves.toMatchObject({ probed: true, changed: false });
  expect(fake.legacyReads).toHaveLength(2);

  // The hidden nested child moved: that is progress, not a stall.
  fake.state.messages = transcript(`${"x".repeat(700 * 1024)} and one more line`);
  fake.state.revision += 1;
  await expect(fake.observe()).resolves.toMatchObject({ probed: true, changed: true });
});

test("a bridge without the conditional route keeps the measured legacy fallback", async () => {
  const fake = bridge("legacy");
  await expect(fake.observe()).resolves.toMatchObject({ baselineEstablished: true });
  await expect(fake.observe()).resolves.toMatchObject({ probed: true, changed: false });
  fake.state.messages = transcript("moved");
  await expect(fake.observe()).resolves.toMatchObject({ probed: true, changed: true });
  expect(fake.legacyReads).toHaveLength(3);
});
