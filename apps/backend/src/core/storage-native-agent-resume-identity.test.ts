import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { INTERACTIVE_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";
import { StorageService } from "./storage.js";
import { nativeAgentSessionResumeIdentity, type PersistedNativeAgentSession } from "./models.js";

/**
 * The resume identity a provider reported for an open session, kept on the
 * tab's mapping so tab teardown can still name the conversation after the
 * session itself is gone (a Codex thread outlives its bridge session).
 */

const input = {
  key: "codex-native-session-key",
  environmentId: "env-1",
  agent: "codex" as const,
  logicalSessionKey: "env-env-1:tab-1",
  origin: "interactive-native" as const,
  interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
};

async function withStorage(
  run: (first: StorageService, second: StorageService) => Promise<void>,
): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-resume-identity-"));
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

describe("native agent session resume identity", () => {
  test("is kept for the mapped session, written only when it changes, and seen by other processes", async () => {
    await withStorage(async (first, second) => {
      await first.adoptNativeAgentSession({ ...input, providerSessionId: "bridge-1" });
      expect(
        await first.recordNativeAgentSessionResumeIdentity(input.key, "bridge-1", "thread-1"),
      ).toBe(true);
      expect(
        await first.recordNativeAgentSessionResumeIdentity(input.key, "bridge-1", "thread-1"),
      ).toBe(false);
      const saved = await second.getNativeAgentSession(input.key);
      expect(saved && nativeAgentSessionResumeIdentity(saved)).toBe("thread-1");

      // A newer report replaces it.
      expect(
        await second.recordNativeAgentSessionResumeIdentity(input.key, "bridge-1", "thread-2"),
      ).toBe(true);
      const updated = await first.getNativeAgentSession(input.key);
      expect(updated && nativeAgentSessionResumeIdentity(updated)).toBe("thread-2");
    });
  });

  test("normalizes padded identities once and leaves repeated observations untouched", async () => {
    await withStorage(async (first) => {
      await first.adoptNativeAgentSession({ ...input, providerSessionId: "bridge-1" });
      expect(
        await first.recordNativeAgentSessionResumeIdentity(input.key, "bridge-1", " thread-1 "),
      ).toBe(true);
      const saved = await first.getNativeAgentSession(input.key);
      expect(saved?.resumeIdentity?.resumableSessionId).toBe("thread-1");
      expect(
        await first.recordNativeAgentSessionResumeIdentity(input.key, "bridge-1", " thread-1 "),
      ).toBe(false);
      expect(await first.getNativeAgentSession(input.key)).toEqual(saved);
    });
  });

  test("never lands on a mapping that has moved to another session, or on none", async () => {
    await withStorage(async (first) => {
      expect(
        await first.recordNativeAgentSessionResumeIdentity(input.key, "bridge-1", "thread-1"),
      ).toBe(false);
      expect(await first.getNativeAgentSession(input.key)).toBeNull();

      await first.adoptNativeAgentSession({ ...input, providerSessionId: "bridge-1" });
      await first.recordNativeAgentSessionResumeIdentity(input.key, "bridge-1", "thread-1");
      const replaced = await first.adoptNativeAgentSession({
        ...input,
        providerSessionId: "bridge-2",
        expectedProviderSessionId: "bridge-1",
      });
      // The replacement is a different conversation: the old thread is not its identity.
      expect(nativeAgentSessionResumeIdentity(replaced)).toBeUndefined();
      expect(
        await first.recordNativeAgentSessionResumeIdentity(input.key, "bridge-1", "thread-stale"),
      ).toBe(false);
      const current = await first.getNativeAgentSession(input.key);
      expect(current && nativeAgentSessionResumeIdentity(current)).toBeUndefined();
    });
  });

  test("rejects a blank identity", async () => {
    await withStorage(async (first) => {
      await first.adoptNativeAgentSession({ ...input, providerSessionId: "bridge-1" });
      await expect(
        first.recordNativeAgentSessionResumeIdentity(input.key, "bridge-1", "  "),
      ).rejects.toThrow("resume identity is invalid");
    });
  });

  test("reads a malformed or stale value as absent", () => {
    const session = (resumeIdentity: unknown) =>
      ({ providerSessionId: "bridge-1", resumeIdentity }) as unknown as Pick<
        PersistedNativeAgentSession,
        "providerSessionId" | "resumeIdentity"
      >;
    expect(nativeAgentSessionResumeIdentity(session(undefined))).toBeUndefined();
    expect(nativeAgentSessionResumeIdentity(session("thread-1"))).toBeUndefined();
    expect(
      nativeAgentSessionResumeIdentity(
        session({ providerSessionId: "bridge-0", resumableSessionId: "thread-0" }),
      ),
    ).toBeUndefined();
    expect(
      nativeAgentSessionResumeIdentity(
        session({ providerSessionId: "bridge-1", resumableSessionId: 7 }),
      ),
    ).toBeUndefined();
    expect(
      nativeAgentSessionResumeIdentity(
        session({ providerSessionId: "bridge-1", resumableSessionId: " thread-1 " }),
      ),
    ).toBe("thread-1");
  });
});
