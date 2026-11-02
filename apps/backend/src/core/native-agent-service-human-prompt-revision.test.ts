import { describe, expect, test } from "bun:test";
import type { ProviderActivityObservation } from "./agent-provider-contract.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service.js";
import { createProviderStub, withService } from "./native-agent-service-projection-test-support.js";

const tab = "env-env-1:tab-1";

describe("humanPromptContentRevision", () => {
  test("follows the activity sweep's content revision and provider session, reading nothing", async () => {
    let observation: ProviderActivityObservation = { state: "working", contentRevision: "g:1" };
    let observations = 0;
    const { provider } = createProviderStub("claude");
    Object.assign(provider, {
      observeActivity: async () => {
        observations += 1;
        return observation;
      },
    });
    await withService(
      { prefix: "ork-human-prompt-revision-", provider: async () => provider },
      async ({ storage, service }) => {
        await storage.adoptNativeAgentSession({
          key: nativeAgentSessionStorageKey("env-1", "claude", tab),
          environmentId: "env-1",
          agent: "claude",
          logicalSessionKey: tab,
          providerSessionId: "provider-1",
        });
        // Before any observation there is nothing to compare against.
        expect(service.humanPromptContentRevision("env-1", "claude", tab)).toBeUndefined();

        await service.reconcileAgentActivity();
        const first = service.humanPromptContentRevision("env-1", "claude", tab);
        expect(first).toBe("provider-1\0g:1");
        const read = observations;
        expect(service.humanPromptContentRevision("env-1", "claude", tab)).toBe(first);
        expect(observations).toBe(read);

        observation = { state: "working", contentRevision: "g:2" };
        await service.reconcileAgentActivity();
        expect(service.humanPromptContentRevision("env-1", "claude", tab)).toBe("provider-1\0g:2");

        // A bridge that reports no revision gives the monitor nothing to reuse on.
        observation = { state: "working" };
        await service.reconcileAgentActivity();
        expect(service.humanPromptContentRevision("env-1", "claude", tab)).toBeUndefined();
      },
    );
  });
});
