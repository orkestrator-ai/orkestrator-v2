/**
 * The projection revision sequence: the legacy full projection and the
 * tool-detail recovery tail (`representation: "detail-recovery"`) are cached
 * under different keys but draw revisions from one sequence per session.
 */
import { describe, expect, test } from "bun:test";

import { createProviderStub, withService } from "./native-agent-service-projection-test-support.js";

describe("native agent projection revisions", () => {
  test("draws legacy and detail-recovery revisions from one sequence per session", async () => {
    let messages = [{ id: "message-0", role: "user" as const, content: "first" }];
    const stub = createProviderStub("cursor", {
      interactiveSnapshot: async () => ({ status: "idle", messages, messagesComplete: true }),
    });
    await withService(
      { prefix: "orkestrator-native-recovery-revision-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:tab-revision",
        };
        await service.ensureSession(identity);
        const recoveryRead = {
          ...identity,
          messageLimit: 100,
          representation: "detail-recovery" as const,
        };

        // Re-project the detail-recovery tail repeatedly, changing the
        // transcript each time so every read commits a new revision.
        let recoveryRevision = 0;
        for (let index = 0; index < 5; index += 1) {
          messages = [
            ...messages,
            { id: `message-${index + 1}`, role: "user", content: `${index}` },
          ];
          const recovery = await service.getProjection(recoveryRead);
          recoveryRevision = recovery!.revision;
        }
        expect(recoveryRevision).toBeGreaterThan(1);

        // A mutation answers on the legacy surface. Both representations
        // cache one session under one generation, so a separate counter would
        // hand back a projection whose revision a client already passed.
        messages = [...messages, { id: "message-stopped", role: "user", content: "stopped" }];
        const legacy = await service.getProjection(identity);
        const latestRecovery = await service.getProjection(recoveryRead);
        expect(legacy!.generation).toBe(latestRecovery!.generation);
        expect(legacy!.revision).toBeGreaterThan(recoveryRevision);
        // And the sequence keeps moving forwards across the representations.
        messages = [...messages, { id: "message-later", role: "user", content: "later" }];
        const later = await service.getProjection(recoveryRead);
        expect(later!.revision).toBeGreaterThan(legacy!.revision);
      },
    );
  });
});
