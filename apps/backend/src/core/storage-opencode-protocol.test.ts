import { describe, expect, test } from "bun:test";
import { INTERACTIVE_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";
import { isPersistedNativeAgentSession } from "./storage-shared-native-sessions.js";
import { withTemporaryStorage } from "./storage-test-support.js";
import type { StorageService } from "./storage.js";

async function addLocalEnvironment(storage: StorageService, id: string) {
  return storage.addEnvironment({
    id,
    projectId: "project-1",
    name: "test",
    branch: "main",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
    setupPhase: "ready",
  });
}

describe("openCodeProtocol setting", () => {
  test("is stored, kept by a save that predates it, and refuses unknown values", async () => {
    await withTemporaryStorage(async (storage) => {
      const config = await storage.loadConfig();
      expect(config.global.openCodeProtocol).toBeUndefined();
      await storage.updateGlobalConfig({ ...config.global, openCodeProtocol: "v2" });
      expect((await storage.loadConfig()).global.openCodeProtocol).toBe("v2");
      const { openCodeProtocol: _omitted, ...older } = (await storage.loadConfig()).global;
      await storage.updateGlobalConfig(older);
      expect((await storage.loadConfig()).global.openCodeProtocol).toBe("v2");
      await storage.updateGlobalConfig({ ...older, openCodeProtocol: "legacy" });
      expect((await storage.loadConfig()).global.openCodeProtocol).toBe("legacy");
      await expect(
        storage.updateGlobalConfig({
          ...older,
          openCodeProtocol: "v3" as unknown as "v2",
        }),
      ).rejects.toThrow(/legacy or v2/);
    });
  });
});

describe("openCodeProtocol session marker", () => {
  test("a created OpenCode 2.x session keeps its marker; absent means legacy", async () => {
    await withTemporaryStorage(async (storage) => {
      await addLocalEnvironment(storage, "env-1");
      const identity = {
        environmentId: "env-1",
        agent: "opencode" as const,
        logicalSessionKey: "env-env-1:tab-1",
      };
      const v2 = await storage.getOrCreateNativeAgentSession(
        { ...identity, key: "k-v2", openCodeProtocol: "v2" },
        async () => "ses_v2",
      );
      expect(v2.openCodeProtocol).toBe("v2");
      expect((await storage.getNativeAgentSession("k-v2"))?.openCodeProtocol).toBe("v2");
      const legacy = await storage.getOrCreateNativeAgentSession(
        { ...identity, logicalSessionKey: "env-env-1:tab-2", key: "k-old" },
        async () => "ses_old",
      );
      expect(legacy.openCodeProtocol).toBeUndefined();
    });
  });

  test("only an OpenCode session may carry the marker", async () => {
    await withTemporaryStorage(async (storage) => {
      await addLocalEnvironment(storage, "env-1");
      await expect(
        storage.getOrCreateNativeAgentSession(
          {
            environmentId: "env-1",
            agent: "claude",
            logicalSessionKey: "env-env-1:tab-1",
            key: "k",
            openCodeProtocol: "v2",
          },
          async () => "s",
        ),
      ).rejects.toThrow(/invalid/);
    });
  });

  test("the validator accepts v2 on OpenCode and nothing else", () => {
    const base = {
      version: 1,
      key: "k",
      environmentId: "env",
      agent: "opencode",
      logicalSessionKey: "tab",
      providerSessionId: "ses",
      origin: "interactive-native",
      interactionPolicy: { ...INTERACTIVE_AGENT_INTERACTION_POLICY },
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    expect(isPersistedNativeAgentSession(base)).toBe(true);
    expect(isPersistedNativeAgentSession({ ...base, openCodeProtocol: "v2" })).toBe(true);
    expect(isPersistedNativeAgentSession({ ...base, openCodeProtocol: "legacy" })).toBe(false);
    expect(
      isPersistedNativeAgentSession({ ...base, agent: "claude", openCodeProtocol: "v2" }),
    ).toBe(false);
  });
});
