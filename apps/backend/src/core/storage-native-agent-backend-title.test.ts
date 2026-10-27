import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { INTERACTIVE_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";
import { StorageService } from "./storage.js";
import { nativeAgentSessionBackendTitle, type PersistedNativeAgentSession } from "./models.js";

/** The title the backend chose for a session, kept on the tab's mapping. */

const input = {
  key: "cursor-native-session-key",
  environmentId: "env-1",
  agent: "cursor" as const,
  logicalSessionKey: "env-env-1:tab-1",
  origin: "interactive-native" as const,
  interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
};

async function withStorage(
  run: (first: StorageService, second: StorageService) => Promise<void>,
): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-backend-title-"));
  const first = new StorageService(dataDir);
  const second = new StorageService(dataDir);
  await Promise.all([first.init(), second.init()]);
  await first.addEnvironment({
    id: "env-1",
    projectId: "project-1",
    name: "Environment",
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
    worktreePath: dataDir,
  });
  try {
    await run(first, second);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

describe("native agent session backend title", () => {
  test("survives a restart, is scoped to its provider session, and marks acceptance", async () => {
    await withStorage(async (first, second) => {
      await first.adoptNativeAgentSession({ ...input, providerSessionId: "agent-1" });
      const generated = {
        providerSessionId: "agent-1",
        title: "Fix the OAuth race",
        source: "generated" as const,
      };
      expect(await first.recordNativeAgentSessionBackendTitle(input.key, generated)).toBe(true);
      expect(await first.recordNativeAgentSessionBackendTitle(input.key, generated)).toBe(false);
      const saved = await second.getNativeAgentSession(input.key);
      expect(saved && nativeAgentSessionBackendTitle(saved)).toEqual(generated);

      expect(
        await second.recordNativeAgentSessionBackendTitle(input.key, {
          ...generated,
          pushed: true,
        }),
      ).toBe(true);
      const accepted = await first.getNativeAgentSession(input.key);
      expect(accepted && nativeAgentSessionBackendTitle(accepted)?.pushed).toBe(true);

      // Another provider session's title neither lands nor reads back.
      expect(
        await first.recordNativeAgentSessionBackendTitle(input.key, {
          ...generated,
          providerSessionId: "agent-2",
        }),
      ).toBe(false);
    });
  });

  test("a late fallback never replaces a generated title", async () => {
    await withStorage(async (first) => {
      await first.adoptNativeAgentSession({ ...input, providerSessionId: "agent-1" });
      await first.recordNativeAgentSessionBackendTitle(input.key, {
        providerSessionId: "agent-1",
        title: "Generated",
        source: "generated",
      });
      expect(
        await first.recordNativeAgentSessionBackendTitle(input.key, {
          providerSessionId: "agent-1",
          title: "first message",
          source: "fallback",
        }),
      ).toBe(false);
      const saved = await first.getNativeAgentSession(input.key);
      expect(saved && nativeAgentSessionBackendTitle(saved)?.title).toBe("Generated");
    });
  });

  test("a malformed or stale stored value reads as absent", () => {
    const session = (backendTitle: unknown) =>
      ({ providerSessionId: "agent-1", backendTitle }) as unknown as Pick<
        PersistedNativeAgentSession,
        "providerSessionId" | "backendTitle"
      >;
    expect(nativeAgentSessionBackendTitle(session(undefined))).toBeUndefined();
    expect(nativeAgentSessionBackendTitle(session("title"))).toBeUndefined();
    expect(
      nativeAgentSessionBackendTitle(
        session({ providerSessionId: "agent-0", title: "Old", source: "generated" }),
      ),
    ).toBeUndefined();
    expect(
      nativeAgentSessionBackendTitle(
        session({ providerSessionId: "agent-1", title: "  ", source: "generated" }),
      ),
    ).toBeUndefined();
    expect(
      nativeAgentSessionBackendTitle(
        session({ providerSessionId: "agent-1", title: "Title", source: "invented" }),
      ),
    ).toBeUndefined();
  });
});
