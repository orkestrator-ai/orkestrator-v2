import { describe, expect, mock, test } from "bun:test";
import {
  addEnvironment,
  createProviderStub,
  waitForCondition,
  withService,
} from "./service-projection-test-support.js";
import { collaborators, projectionInternals } from "./service-test-collaborators.js";
import { nativeAgentSessionStorageKey } from "./service-shared.js";
import type { NativeAgentService } from "./service.js";

const input = (environmentId: string, logicalSessionKey = environmentId) => ({
  environmentId,
  agent: "cursor" as const,
  logicalSessionKey,
  viewVersion: 1 as const,
  sections: ["runtime" as const],
});
const health = { summary: { state: "attached" }, notices: [], authoritative: true };

async function withHeldDiscovery(
  run: (context: {
    service: NativeAgentService;
    calls: string[];
    release: () => void;
    announcements: string[];
    peak: () => { global: number; provider: number };
  }) => Promise<void>,
) {
  let now = 1_000;
  let held = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: string[] = [];
  const active = new Map<string, number>();
  let globalActive = 0;
  let peakGlobal = 0;
  let peakProvider = 0;
  const providers = new Map<string, ReturnType<typeof createProviderStub>["provider"]>();
  const announcements: string[] = [];
  await withService(
    {
      prefix: "orkestrator-discovery-queue-",
      now: () => now,
      provider: async ({ environmentId }) => {
        let provider = providers.get(environmentId);
        if (!provider) {
          let ordinal = 0;
          provider = createProviderStub("cursor", {
            createSession: async () => `${environmentId}-${ordinal++}`,
          }).provider;
          Object.assign(provider, {
            runtimeHealth: mock(async (sessionId: string) => {
              calls.push(sessionId);
              globalActive += 1;
              active.set(environmentId, (active.get(environmentId) ?? 0) + 1);
              peakGlobal = Math.max(peakGlobal, globalActive);
              peakProvider = Math.max(peakProvider, active.get(environmentId)!);
              try {
                if (held) await gate;
                await Promise.resolve();
                return health;
              } finally {
                globalActive -= 1;
                active.set(environmentId, active.get(environmentId)! - 1);
              }
            }),
          });
          providers.set(environmentId, provider);
        }
        return provider;
      },
    },
    async ({ service, storage }) => {
      for (const id of ["env-2", "target"]) await addEnvironment(storage, { id });
      storage.addResourceChangeListener((change) => {
        if (change.resource === "native-agent-session") announcements.push(change.id ?? "");
      });
      // Give the target a retained value, then saturate all four slots elsewhere.
      await service.ensureSession(input("target"));
      await service.getDiscoveryUpdate(input("target"));
      const view = projectionInternals(service);
      await waitForCondition(() => view.progressiveReads.size === 0);
      now += 31_000;
      held = true;
      for (const env of ["env-1", "env-2"]) {
        for (let n = 0; n < 2; n++) {
          const request = input(env, `held-${n}`);
          await service.ensureSession(request);
          await service.getDiscoveryUpdate(request);
        }
      }
      await waitForCondition(() => globalActive === 4);
      try {
        await run({
          service,
          calls,
          announcements,
          release: () => {
            held = false;
            release();
          },
          peak: () => ({ global: peakGlobal, provider: peakProvider }),
        });
      } finally {
        held = false;
        release();
        await waitForCondition(
          () => view.progressiveReads.size === 0 && view.deferredDiscoveryRenewals.size === 0,
        );
      }
    },
  );
}

describe("deferred discovery lifetime and bounds", () => {
  for (const mode of ["invalidate", "forget", "queued-only"] as const) {
    test(`drops queued renewals on ${mode} before an epoch can reset`, async () => {
      await withHeldDiscovery(async ({ service, calls, announcements, release }) => {
        const request = input("target", mode === "queued-only" ? "new-session" : "target");
        if (mode === "queued-only") await service.ensureSession(request);
        await service.getDiscoveryUpdate(request);
        const view = projectionInternals(service);
        const key = nativeAgentSessionStorageKey(
          request.environmentId,
          request.agent,
          request.logicalSessionKey,
        );
        expect(view.deferredDiscoveryRenewals.size).toBe(1);
        // No projection, state or transcript identifies this new queued-only session.
        if (mode === "queued-only") {
          view.projectionCache.delete(key);
          expect(
            view.progressiveDiscoveryCache.has(`${key}\0progressive-v1\0discovery:runtime`),
          ).toBe(false);
        }
        if (mode === "invalidate") view.invalidateProjection(key);
        else service.forgetEnvironmentProjections("target");
        view.pruneProjectionEpoch(key);
        expect(view.projectionEpochs.has(key)).toBe(false);
        expect(view.deferredDiscoveryRenewals.size).toBe(0);
        const targetReads = calls.filter((id) => id.startsWith("target-")).length;
        announcements.length = 0;
        release();
        await waitForCondition(() => view.progressiveReads.size === 0);
        expect(calls.filter((id) => id.startsWith("target-"))).toHaveLength(targetReads);
        expect(
          Array.from(view.progressiveDiscoveryCache.keys()).some((candidate) =>
            candidate.startsWith(`${key}\0`),
          ),
        ).toBe(false);
        expect(announcements).not.toContain("target");
      });
    });
  }

  test("bounds the queue to 256 and drains without exceeding global or provider limits", async () => {
    await withHeldDiscovery(async ({ service, calls, release, peak }) => {
      const view = projectionInternals(service);
      for (let n = 0; n < 258; n++) {
        const request = input(["target", "env-1", "env-2"][n % 3]!, `queued-${n}`);
        await service.ensureSession(request);
        await service.getDiscoveryUpdate(request);
      }
      expect(view.deferredDiscoveryRenewals.size).toBe(256);
      expect(collaborators(service).projections.cacheGauges().deferredDiscoveryRenewals).toBe(256);
      const firstKey = nativeAgentSessionStorageKey("target", "cursor", "queued-0");
      expect(
        Array.from(view.deferredDiscoveryRenewals.keys()).some((key) =>
          key.startsWith(`${firstKey}\0`),
        ),
      ).toBe(false);
      const before = calls.length;
      release();
      await waitForCondition(
        () => view.progressiveReads.size === 0 && view.deferredDiscoveryRenewals.size === 0,
      );
      expect(calls.length - before).toBe(256);
      expect(peak()).toEqual({ global: 4, provider: 2 });
      expect(collaborators(service).projections.cacheGauges().deferredDiscoveryRenewals).toBe(0);
    });
  }, 30_000);
});
