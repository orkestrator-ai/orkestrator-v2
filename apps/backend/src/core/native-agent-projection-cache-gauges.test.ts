/**
 * The native projection's cache gauges (todo 0048 task 10): every per-session
 * map reports its size to recurring diagnostics while the service runs, the
 * counts carry no session key or content, and shutdown unregisters them.
 */
import { expect, test } from "bun:test";
import { recurringWorkDiagnostics } from "./recurring-diagnostics.js";
import { createProviderStub, withService } from "./native-agent-service-projection-test-support.js";

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
