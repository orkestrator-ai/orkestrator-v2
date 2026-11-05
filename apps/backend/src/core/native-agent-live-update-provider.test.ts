import { expect, test } from "bun:test";
import { readNativeAgentLiveUpdate } from "./native-agent-live-update.js";
import { NATIVE_AGENT_PROGRESSIVE_VIEW_VERSION } from "@orkestrator/protocol/native-agent";
import {
  createProviderStub,
  waitForCondition,
  withService,
} from "./native-agent-service-projection-test-support.js";

test("pending transcript follow-up joins the existing provider read", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stub = createProviderStub("cursor", {
    transcriptSnapshot: async () => {
      calls++;
      await gate;
      return { messages: [], complete: true, freshness: "current" as const };
    },
    sessionStateSnapshot: async () => ({ status: "idle" as const }),
  });
  await withService(
    { prefix: "ork-live-update-join-", provider: async () => stub.provider },
    async ({ service }) => {
      const input = {
        environmentId: "env-1",
        agent: "cursor" as const,
        logicalSessionKey: "env-env-1:join",
        viewVersion: 1 as const,
        liveWindow: { messages: 100, targetBytes: 512 * 1024 },
      };
      await service.ensureSession(input);
      try {
        const update = await readNativeAgentLiveUpdate(service, input, 5);
        expect(update.transcript.status).toBe("pending");
        await waitForCondition(() => calls === 1);
        const follow = service.getTranscriptUpdate({
          ...input,
          viewVersion: NATIVE_AGENT_PROGRESSIVE_VIEW_VERSION,
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(calls).toBe(1);
        release();
        expect((await follow).status).toBe("snapshot");
        expect(calls).toBe(1);
      } finally {
        release();
      }
    },
  );
});
