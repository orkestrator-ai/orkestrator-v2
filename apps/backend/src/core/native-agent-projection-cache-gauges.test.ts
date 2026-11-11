/**
 * The native projection's cache gauges (todo 0048 task 10): every per-session
 * map reports its size to recurring diagnostics while the service runs, the
 * counts carry no session key or content, and shutdown unregisters them.
 */
import { expect, test } from "bun:test";
import { recurringWorkDiagnostics } from "./recurring-diagnostics.js";
import {
  createProviderStub,
  waitForCondition,
  withService,
} from "./native-agent-service-projection-test-support.js";

const identity = {
  environmentId: "env-1",
  agent: "codex" as const,
  logicalSessionKey: "env-env-1:tab-cache-gauges",
};

const projectionSources = () =>
  recurringWorkDiagnostics().caches.find((entry) => entry.name === "native-projection")?.sources ??
  0;

test("a projected session shows in the projection gauges, content-free, until shutdown", async () => {
  const secret = "projection-gauge-secret-text";
  const stub = createProviderStub("codex", {
    interactiveSnapshot: async () => ({
      status: "idle",
      messages: [
        {
          id: "assistant-1",
          role: "assistant" as const,
          content: secret,
          parts: [{ type: "text", content: secret }],
          createdAt: "2026-11-05T10:00:00.000Z",
        },
      ],
    }),
  });
  const before = projectionSources();
  await withService(
    { prefix: "orkestrator-native-cache-gauges-", provider: async () => stub.provider },
    async ({ service }) => {
      expect(projectionSources()).toBe(before + 1);
      await service.ensureSession(identity);
      await service.getProjection(identity);
      const entry = recurringWorkDiagnostics().caches.find(
        (cache) => cache.name === "native-projection",
      );
      expect(entry?.gauges.projections).toBeGreaterThanOrEqual(1);
      expect(entry?.gauges.projectionRevisions).toBeGreaterThanOrEqual(1);
      for (const value of Object.values(entry!.gauges)) {
        expect(Number.isInteger(value) && value >= 0).toBe(true);
      }
      const serialized = JSON.stringify(entry);
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain("tab-cache-gauges");
      expect(serialized).not.toContain("env-1");
    },
  );
  expect(projectionSources()).toBe(before);
});

test("deleting an environment releases its sessions' projection caches, and only its own", async () => {
  const stub = createProviderStub("codex", {
    interactiveSnapshot: async () => ({
      status: "idle",
      messages: [
        {
          id: "assistant-1",
          role: "assistant" as const,
          content: "reply",
          parts: [{ type: "text", content: "reply" }],
          createdAt: "2026-11-05T10:00:00.000Z",
        },
      ],
    }),
  });
  const gauges = () =>
    recurringWorkDiagnostics().caches.find((cache) => cache.name === "native-projection")!.gauges;
  await withService(
    { prefix: "orkestrator-native-forget-env-", provider: async () => stub.provider },
    async ({ service }) => {
      await service.ensureSession(identity);
      await service.getProjection(identity);
      const held = gauges();
      expect(held.projections).toBeGreaterThanOrEqual(1);
      expect(held.projectionRevisions).toBeGreaterThanOrEqual(1);

      // Another environment's deletion leaves this one's caches alone.
      service.forgetEnvironmentProjections("env-other");
      expect(gauges()).toEqual(held);

      service.forgetEnvironmentProjections("env-1");
      expect(gauges()).toMatchObject({
        projections: 0,
        projectionSync: 0,
        projectionRevisions: 0,
        projectionHistory: 0,
        projectionEpochs: 0,
        projectionMissingSince: 0,
        toolDetails: 0,
        projectedMessages: 0,
        projectedMessageSessions: 0,
        progressiveTranscripts: 0,
        progressiveReadEpochs: 0,
        directHistoryPages: 0,
      });
    },
  );
});

for (const mode of ["legacy", "sync-v1", "transcript", "state"] as const) {
  for (const inFlight of [false, true]) {
    test(`deletion releases a first ${mode} read (${inFlight ? "in flight" : "settled"})`, async () => {
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const snapshot = async () => {
        entered();
        if (inFlight) await gate;
        return {
          status: "idle" as const,
          messages: [
            {
              id: "late-row",
              role: "assistant" as const,
              content: "late response",
              parts: [{ type: "text", content: "late response" }],
              createdAt: "2026-11-06T00:00:00Z",
            },
          ],
        };
      };
      const stub = createProviderStub("codex", { interactiveSnapshot: snapshot });
      const gauges = () =>
        recurringWorkDiagnostics().caches.find((cache) => cache.name === "native-projection")!
          .gauges;
      await withService(
        { prefix: "orkestrator-native-forget-first-", provider: async () => stub.provider },
        async ({ service, storage }) => {
          await service.ensureSession(identity);
          const read = () =>
            mode === "transcript"
              ? service.getTranscriptUpdate({
                  ...identity,
                  viewVersion: 1,
                  liveWindow: { messages: 40, targetBytes: 512 * 1024 },
                  forceSnapshot: true,
                })
              : mode === "state"
                ? service.getSessionStateUpdate({
                    ...identity,
                    viewVersion: 1,
                    forceSnapshot: true,
                  })
                : service.getProjection({
                    ...identity,
                    ...(mode === "sync-v1" ? { representation: "sync-v1" as const } : {}),
                  });
          const pending = read();
          try {
            await started;
            if (!inFlight) await pending;
            if (mode === "transcript" || mode === "state") expect(gauges().projections).toBe(0);
            await storage.deleteNativeAgentSessionsByEnvironment(identity.environmentId);
            service.forgetEnvironmentProjections(identity.environmentId);
            if (inFlight) expect(gauges().projectionEpochs).toBeGreaterThan(0);
          } finally {
            release();
            await pending;
          }
          expect(
            service.cachedProjectionSnapshot(
              identity.environmentId,
              identity.agent,
              identity.logicalSessionKey,
            ),
          ).toBeNull();
          expect(gauges()).toMatchObject({
            projections: 0,
            projectionRefreshes: 0,
            projectionSync: 0,
            projectionRevisions: 0,
            projectionEpochs: 0,
            progressiveReads: 0,
            progressiveReadEpochs: 0,
            progressiveTranscripts: 0,
            progressiveStates: 0,
            projectedMessages: 0,
          });
        },
      );
    });
  }
}

/*
 * Todo 7100 task 3: three per-session maps of the projection were emptied only
 * by an invalidation, an environment deletion or shutdown, so every session a
 * reader opened and left kept an entry. Each now lives as long as the thing it
 * belongs to.
 */
const liveWindow = { messages: 40, targetBytes: 512 * 1024 };
const row = (content: string) => ({
  id: `row-${content}`,
  role: "assistant" as const,
  content,
  parts: [{ type: "text", content }],
  createdAt: "2026-11-11T00:00:00.000Z",
});

test("a settled progressive read keeps neither its epoch nor its snapshot share", async () => {
  let content = "first reply";
  const stub = createProviderStub("codex", {
    interactiveSnapshot: async () => ({ status: "idle", messages: [row(content)] }),
  });
  const gauges = () =>
    recurringWorkDiagnostics().caches.find((cache) => cache.name === "native-projection")!.gauges;
  await withService(
    { prefix: "orkestrator-native-settled-reads-", provider: async () => stub.provider },
    async ({ service }) => {
      await service.ensureSession(identity);
      const transcript = () =>
        service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
          forceSnapshot: true,
        });
      const state = () =>
        service.getSessionStateUpdate({ ...identity, viewVersion: 1, forceSnapshot: true });
      const [first] = await Promise.all([transcript(), state()]);
      if (first.status !== "snapshot") throw new Error("expected snapshot");
      expect(JSON.stringify(first.value.messages)).toContain("first reply");
      expect(gauges()).toMatchObject({
        progressiveReads: 0,
        progressiveReadEpochs: 0,
        interactiveSnapshotShares: 0,
      });

      // A streamed row moves no epoch; a settled share kept for the epoch
      // answered this read with the snapshot above.
      content = "second reply";
      const second = await transcript();
      if (second.status !== "snapshot") throw new Error("expected snapshot");
      expect(JSON.stringify(second.value.messages)).toContain("second reply");
      expect(gauges()).toMatchObject({ progressiveReadEpochs: 0, interactiveSnapshotShares: 0 });
      // Reads issued together still share one provider snapshot
      // (native-agent-service-progressive.test.ts); this read had none to join.
      expect(stub.interactiveSnapshot).toHaveBeenCalledTimes(2);
    },
  );
});

test("a discovery read in flight does not pin a settled snapshot share", async () => {
  let content = "first reply";
  let releaseDiscovery!: () => void;
  const discoveryHeld = new Promise<void>((resolve) => {
    releaseDiscovery = resolve;
  });
  let discoveryEntered!: () => void;
  const discoveryStarted = new Promise<void>((resolve) => {
    discoveryEntered = resolve;
  });
  const stub = createProviderStub("claude", {
    interactiveSnapshot: async () => ({ status: "idle", messages: [row(content)] }),
    slashCommands: async () => {
      discoveryEntered();
      await discoveryHeld;
      return [];
    },
  });
  const session = { ...identity, agent: "claude" as const };
  const gauges = () =>
    recurringWorkDiagnostics().caches.find((cache) => cache.name === "native-projection")!.gauges;
  await withService(
    { prefix: "orkestrator-native-discovery-share-", provider: async () => stub.provider },
    async ({ service }) => {
      await service.ensureSession(session);
      const transcript = () =>
        service.getTranscriptUpdate({
          ...session,
          viewVersion: 1,
          liveWindow,
          forceSnapshot: true,
        });
      const state = () =>
        service.getSessionStateUpdate({ ...session, viewVersion: 1, forceSnapshot: true });
      try {
        // Discovery runs behind the view that asked for it, so this read
        // returns while the slash-command read is still held.
        await service.getDiscoveryUpdate({ ...session, viewVersion: 1, sections: ["commands"] });
        await discoveryStarted;
        expect(gauges().progressiveReads).toBe(1);

        const [first] = await Promise.all([transcript(), state()]);
        if (first.status !== "snapshot") throw new Error("expected snapshot");
        expect(JSON.stringify(first.value.messages)).toContain("first reply");
        // The discovery read never joins a share, so it must not keep one.
        expect(gauges()).toMatchObject({ progressiveReads: 1, interactiveSnapshotShares: 0 });
      } finally {
        releaseDiscovery();
      }
      await waitForCondition(async () => gauges().progressiveReads === 0);
      expect(gauges().interactiveSnapshotShares).toBe(0);

      content = "second reply";
      const second = await transcript();
      if (second.status !== "snapshot") throw new Error("expected snapshot");
      expect(JSON.stringify(second.value.messages)).toContain("second reply");
      expect(stub.interactiveSnapshot).toHaveBeenCalledTimes(2);
      expect(gauges().interactiveSnapshotShares).toBe(0);
    },
  );
});

test("an evicted transcript takes its source token with it", async () => {
  const stub = createProviderStub("codex", {
    transcriptSnapshot: async (sessionId) => ({
      messages: [row(`reply for ${sessionId}`)],
      complete: true,
      sourceToken: `source-${sessionId}`,
      historyEpoch: "1:1",
      freshness: "current" as const,
    }),
  });
  const gauges = () =>
    recurringWorkDiagnostics().caches.find((cache) => cache.name === "native-projection")!.gauges;
  let created = 0;
  stub.createSession.mockImplementation(async () => `provider-session-${(created += 1)}`);
  await withService(
    { prefix: "orkestrator-native-source-tokens-", provider: async () => stub.provider },
    async ({ service }) => {
      // The progressive transcript cache keeps 128 views.
      for (let index = 0; index < 136; index += 1) {
        const session = { ...identity, logicalSessionKey: `env-env-1:tab-evict-${index}` };
        await service.ensureSession(session);
        const update = await service.getTranscriptUpdate({
          ...session,
          viewVersion: 1,
          liveWindow,
          forceSnapshot: true,
        });
        if (update.status !== "snapshot") throw new Error("expected snapshot");
      }
      const held = gauges();
      expect(held.progressiveTranscripts).toBe(128);
      expect(held.progressiveSourceTokens).toBe(128);
      expect(held.progressiveReadEpochs).toBe(0);
    },
  );
});

test("an evicted transcript cancels its pending recovery, and a late one cannot restore it", async () => {
  // provider-session-1 recovers through a read held in flight, -2 through a
  // timer still waiting; every other session is a complete filler.
  const inFlight = "provider-session-1";
  const waiting = "provider-session-2";
  const revisions = new Map<string, number>();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let recoveryEntered!: () => void;
  const recoveryStarted = new Promise<void>((resolve) => {
    recoveryEntered = resolve;
  });
  const recovered: string[] = [];
  const messages = async (sessionId: string) => {
    recovered.push(sessionId);
    if (sessionId === inFlight) {
      recoveryEntered();
      await gate;
    }
    return [row("m0"), row("m1"), row("m2")];
  };
  const stub = createProviderStub("codex", {
    messages,
    transcriptSnapshot: async (sessionId) =>
      sessionId === inFlight || sessionId === waiting
        ? {
            messages: [row("m2")],
            complete: false,
            // A cached summary always asks for exact recovery.
            freshness: "cached" as const,
            representation: "summary" as const,
            sourceToken: `cached-${sessionId}-${revisions.get(sessionId) ?? 0}`,
          }
        : {
            messages: [row(`reply for ${sessionId}`)],
            complete: true,
            sourceToken: `source-${sessionId}`,
            historyEpoch: "1:1",
            freshness: "current" as const,
          },
  });
  let created = 0;
  stub.createSession.mockImplementation(async () => `provider-session-${(created += 1)}`);
  const gauges = () =>
    recurringWorkDiagnostics().caches.find((cache) => cache.name === "native-projection")!.gauges;
  await withService(
    {
      prefix: "orkestrator-native-evict-recovery-",
      provider: async () => stub.provider,
      // Long enough that no waiting timer fires during the test.
      progressiveHydrationSettleMs: 60_000,
    },
    async ({ service }) => {
      const session = (index: number) => ({
        ...identity,
        logicalSessionKey: `env-env-1:tab-recovery-${index}`,
      });
      const read = async (index: number) => {
        const update = await service.getTranscriptUpdate({
          ...session(index),
          viewVersion: 1,
          liveWindow,
          forceSnapshot: true,
        });
        if (update.status !== "snapshot") throw new Error("expected snapshot");
        return update.value.messages;
      };
      // Shutdown waits for a recovery in flight, so a failed assertion must
      // still release the held read.
      try {
        await service.ensureSession(session(0));
        await service.ensureSession(session(1));

        // Session 0: the first recovery of a quiet view starts at once and is held.
        await read(0);
        await recoveryStarted;
        // Session 1: its first recovery runs; a newer revision then waits out
        // the settle interval behind a timer.
        await read(1);
        await waitForCondition(() => recovered.includes(waiting));
        revisions.set(waiting, 1);
        await read(1);
        expect(gauges()).toMatchObject({ progressiveHydrations: 2, progressiveHydrationTimers: 1 });

        // 128 newer views evict both (the progressive transcript cache keeps 128).
        for (let index = 2; index < 130; index += 1) {
          await service.ensureSession(session(index));
          await read(index);
        }
        expect(gauges()).toMatchObject({
          progressiveTranscripts: 128,
          progressiveSourceTokens: 128,
          progressiveHydrations: 0,
          progressiveHydrationTimers: 0,
        });

        // A replacement view of session 0 schedules its own recovery behind the
        // settle interval; the old read then lands and must be dropped.
        expect(await read(0)).toHaveLength(1);
        expect(gauges()).toMatchObject({ progressiveHydrations: 1, progressiveHydrationTimers: 1 });
        release();
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(await read(0)).toHaveLength(1);
        expect(gauges()).toMatchObject({
          progressiveTranscripts: 128,
          progressiveHydrations: 1,
          progressiveHydrationTimers: 1,
        });
      } finally {
        release();
      }
    },
  );
});
