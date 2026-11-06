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
