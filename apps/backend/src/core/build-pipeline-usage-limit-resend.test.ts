import { expect, spyOn, test } from "bun:test";
import type { UsageLimitStopVerdict } from "@orkestrator/protocol/agent-account-auto-switch";
import {
  advanceUntil,
  fourReviewers,
  startInput,
  withPipeline,
} from "./build-pipeline-review-fanout-test-support.js";

const LIMIT = "You've hit your limit · resets 3pm";

function withVerdict(provider: object, verdicts: UsageLimitStopVerdict[]) {
  const calls: Array<{ resends: number; error: string | undefined }> = [];
  Object.assign(provider, {
    usageLimitStop: async (input: { resends: number; error: string | undefined }) => {
      calls.push({ resends: input.resends, error: input.error });
      return verdicts.shift() ?? "stop";
    },
  });
  return calls;
}

test("a stage the weekly limit stopped continues on the new account exactly once", async () => {
  await withPipeline(async ({ service, provider, read }) => {
    const calls = withVerdict(provider, ["wait", "resend"]);
    const started = await service.start(startInput());
    const building = await advanceUntil(service, read, started.id, "building");
    const session = building.sessions[building.currentSessionIndex]!;
    const firstRequestId = session.structuredRequestId;
    // No result reached the backend: the turn stopped before submitting one.
    provider.structured = async () => null;
    let stopped = true;
    spyOn(provider, "observeSession").mockImplementation(async (sessionId) =>
      sessionId === session.sdkSessionId && stopped
        ? { status: "error", error: LIMIT }
        : { status: "idle" },
    );
    const sentBefore = provider.sent.length;

    // Waiting on the verdict neither fails the stage nor sends anything.
    await service.advanceNow(started.id);
    let current = await read(started.id);
    expect(current.phase).toBe("building");
    expect(provider.sent).toHaveLength(sentBefore);

    await service.advanceNow(started.id);
    current = await read(started.id);
    expect(current.phase).toBe("building");
    expect(current.error).toBeUndefined();
    expect(current.sessions[current.currentSessionIndex]).toMatchObject({
      sdkSessionId: session.sdkSessionId,
      usageLimitResends: 1,
    });
    expect(provider.sent).toHaveLength(sentBefore + 1);
    const resend = provider.sent.at(-1)!;
    expect(resend.sessionId).toBe(session.sdkSessionId);
    expect(resend.requestId).not.toBe(firstRequestId);
    expect(resend.prompt).toContain("weekly usage limit ran out");
    expect(calls.map((call) => call.resends)).toEqual([0, 0]);
    expect(calls[0]?.error).toBe(LIMIT);

    // Once the bridge starts the resend the old error is gone: no second stop.
    stopped = false;
    await service.advanceNow(started.id);
    expect(calls).toHaveLength(2);
    expect(current.sessions.filter((entry) => entry.usageLimitResends)).toHaveLength(1);
  });
});

test("a resend the new account refuses too hands on its count, and the verdict ends it", async () => {
  await withPipeline(async ({ service, provider, read }) => {
    const calls = withVerdict(provider, ["resend", "stop"]);
    const started = await service.start(startInput());
    const building = await advanceUntil(service, read, started.id, "building");
    const session = building.sessions[building.currentSessionIndex]!;
    provider.structured = async () => null;
    spyOn(provider, "observeSession").mockImplementation(async (sessionId) =>
      sessionId === session.sdkSessionId ? { status: "error", error: LIMIT } : { status: "idle" },
    );
    await service.advanceNow(started.id);
    expect((await read(started.id)).phase).toBe("building");
    await service.advanceNow(started.id);
    expect(calls.map((call) => call.resends)).toEqual([0, 1]);
    expect((await read(started.id)).phase).toBe("failed");
  });
});

test("a stage whose limit stays unconfirmed fails as before", async () => {
  await withPipeline(async ({ service, provider, read }) => {
    withVerdict(provider, ["stop"]);
    const started = await service.start(startInput());
    const building = await advanceUntil(service, read, started.id, "building");
    const session = building.sessions[building.currentSessionIndex]!;
    spyOn(provider, "observeSession").mockImplementation(async (sessionId) =>
      sessionId === session.sdkSessionId ? { status: "error", error: LIMIT } : { status: "idle" },
    );
    const sentBefore = provider.sent.length;
    await service.advanceNow(started.id);
    const current = await read(started.id);
    expect(current.phase).toBe("failed");
    expect(current.error).toContain(LIMIT);
    expect(provider.sent).toHaveLength(sentBefore);
  });
});

test("a stage that already submitted its result moves on without a resend", async () => {
  await withPipeline(
    async ({ service, provider, read, workflowResults }) => {
      withVerdict(provider, ["resend"]);
      const started = await service.start(startInput());
      const building = await advanceUntil(service, read, started.id, "building");
      const session = building.sessions[building.currentSessionIndex]!;
      const requestId = session.structuredRequestId!;
      const result = await provider.structured<unknown>(session.sdkSessionId, requestId);
      if (result?.ok) {
        await workflowResults!.submit(
          { environmentId: "env-1", projectId: "project-1" },
          requestId,
          result.value,
        );
      }
      spyOn(provider, "observeSession").mockImplementation(async (sessionId) =>
        sessionId === session.sdkSessionId ? { status: "error", error: LIMIT } : { status: "idle" },
      );
      const sentBefore = provider.sent.length;
      await service.advanceNow(started.id);
      const current = await read(started.id);
      expect(current.phase).toBe("reviewing");
      expect(current.sessions.some((entry) => entry.usageLimitResends)).toBe(false);
      expect(
        provider.sent.slice(sentBefore).filter((entry) => entry.sessionId === session.sdkSessionId),
      ).toEqual([]);
    },
    { toolMode: true, toolKinds: ["review-preparation"] },
  );
});

test("a pipeline's consolidation continues on the new account", async () => {
  await withPipeline(async ({ service, provider, read }) => {
    withVerdict(provider, ["resend"]);
    provider.runningConsolidation = true;
    const started = await service.start(startInput(fourReviewers()));
    let current = await read(started.id);
    for (let pass = 0; pass < 20 && !current.reviewFanout?.consolidation; pass++) {
      await service.advanceNow(started.id);
      current = await read(started.id);
    }
    const first = current.reviewFanout!.consolidation!;
    provider.missingConsolidationResult = true;
    let stopped = true;
    spyOn(provider, "observeSession").mockImplementation(async (sessionId) =>
      sessionId === first.providerSessionId && stopped
        ? { status: "error", error: LIMIT }
        : { status: await provider.status(sessionId) },
    );
    await service.advanceNow(started.id);
    current = await read(started.id);
    const continuation = current.reviewFanout!.consolidation!;
    expect(continuation).toMatchObject({
      state: "prepared",
      usageLimitResends: 1,
      providerSessionId: first.providerSessionId,
    });
    expect(continuation.requestId).not.toBe(first.requestId);

    stopped = false;
    await service.advanceNow(started.id);
    expect(provider.sent.at(-1)).toMatchObject({
      sessionId: first.providerSessionId,
      requestId: continuation.requestId,
    });
    expect(provider.sent.at(-1)?.prompt).toContain("weekly usage limit ran out");
  });
});

test("a pipeline's consolidation fails as before when nothing can take over", async () => {
  await withPipeline(async ({ service, provider, read }) => {
    withVerdict(provider, ["stop"]);
    provider.runningConsolidation = true;
    const started = await service.start(startInput(fourReviewers()));
    let current = await read(started.id);
    for (let pass = 0; pass < 20 && !current.reviewFanout?.consolidation; pass++) {
      await service.advanceNow(started.id);
      current = await read(started.id);
    }
    const first = current.reviewFanout!.consolidation!;
    spyOn(provider, "observeSession").mockImplementation(async (sessionId) =>
      sessionId === first.providerSessionId
        ? { status: "error", error: LIMIT }
        : { status: await provider.status(sessionId) },
    );
    await service.advanceNow(started.id);
    expect((await read(started.id)).phase).toBe("failed");
  });
});
