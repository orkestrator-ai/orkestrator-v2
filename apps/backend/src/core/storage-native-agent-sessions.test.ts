import { describe, expect, jest, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StorageService } from "./storage.js";

async function withStorage(
  run: (first: StorageService, second: StorageService) => Promise<void>,
): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-native-sessions-"));
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

const input = {
  key: "native-session-key",
  environmentId: "env-1",
  agent: "opencode" as const,
  logicalSessionKey: "env-env-1:startup-agent",
};

describe("StorageService native agent sessions", () => {
  test("heartbeats a long-held environment mutation lock across backend processes", async () => {
    await withStorage(async (first, second) => {
      let signalEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        signalEntered = resolve;
      });
      let releaseOperation!: () => void;
      const operationBarrier = new Promise<void>((resolve) => {
        releaseOperation = resolve;
      });

      jest.useFakeTimers();
      try {
        const held = first.runWithLiveEnvironment(
          "env-1",
          "Held operation",
          async () => {
            signalEntered();
            await operationBarrier;
          },
        );
        await entered;

        // Move beyond the stale-lock threshold. The 5-second heartbeat must
        // keep the lock's mtime fresh so another process cannot steal it.
        jest.advanceTimersByTime(16_000);
        await Promise.resolve();
        await Promise.resolve();

        let contenderEntered = false;
        const contender = second.runWithLiveEnvironment(
          "env-1",
          "Contending operation",
          async () => {
            contenderEntered = true;
          },
        );
        for (let attempt = 0; attempt < 10; attempt += 1) {
          await fs.stat(path.join(
            (await first.getEnvironment("env-1"))?.worktreePath ?? "",
            "environments.json.lock",
          )).catch(() => undefined);
        }
        expect(contenderEntered).toBe(false);

        releaseOperation();
        await held;
        jest.advanceTimersByTime(25);
        await contender;
        expect(contenderEntered).toBe(true);
      } finally {
        releaseOperation();
        jest.useRealTimers();
      }
    });
  });

  test("creates one provider session for a logical session across backend processes", async () => {
    await withStorage(async (first, second) => {
      const createProviderSession = mock(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return "provider-session";
      });

      const [left, right] = await Promise.all([
        first.getOrCreateNativeAgentSession(input, createProviderSession),
        second.getOrCreateNativeAgentSession(input, createProviderSession),
      ]);

      expect(createProviderSession).toHaveBeenCalledTimes(1);
      expect(left.providerSessionId).toBe("provider-session");
      expect(right).toEqual(left);
    });
  });

  test("dispatches a stable request once across backend processes", async () => {
    await withStorage(async (first, second) => {
      await first.getOrCreateNativeAgentSession(input, async () => "provider-session");
      const dispatch = mock(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      const [left, right] = await Promise.all([
        first.dispatchNativeAgentPromptOnce(input.key, "request-1", dispatch),
        second.dispatchNativeAgentPromptOnce(input.key, "request-1", dispatch),
      ]);

      expect(dispatch).toHaveBeenCalledTimes(1);
      expect([left.dispatched, right.dispatched].sort()).toEqual([false, true]);
      expect((await first.getNativeAgentSession(input.key))?.dispatchedRequestIds)
        .toEqual(["request-1"]);
    });
  });

  test("conditionally invalidates only the provider session that was checked", async () => {
    await withStorage(async (first) => {
      await first.getOrCreateNativeAgentSession(input, async () => "provider-session");
      expect(
        await first.invalidateNativeAgentSession(input.key, "another-session"),
      ).toBe(false);
      expect(await first.getNativeAgentSession(input.key)).not.toBeNull();
      expect(
        await first.invalidateNativeAgentSession(input.key, "provider-session"),
      ).toBe(true);
      expect(await first.getNativeAgentSession(input.key)).toBeNull();
    });
  });

  test("adopts and compare-and-swaps an existing provider session", async () => {
    await withStorage(async (first) => {
      const adopted = await first.adoptNativeAgentSession({
        ...input,
        providerSessionId: "provider-old",
      });
      expect((await first.adoptNativeAgentSession({
        ...input,
        providerSessionId: "provider-old",
      })).providerSessionId).toBe(adopted.providerSessionId);
      await first.dispatchNativeAgentPromptOnce(
        input.key,
        "request-old",
        async () => undefined,
      );
      await expect(first.adoptNativeAgentSession({
        ...input,
        providerSessionId: "provider-new",
      })).rejects.toThrow("provider collision");
      await expect(first.adoptNativeAgentSession({
        ...input,
        providerSessionId: "provider-new",
        expectedProviderSessionId: "wrong-old",
      })).rejects.toThrow("provider collision");

      const replaced = await first.adoptNativeAgentSession({
        ...input,
        providerSessionId: "provider-new",
        expectedProviderSessionId: "provider-old",
      });
      expect(replaced.providerSessionId).toBe("provider-new");
      expect(replaced.dispatchedRequestIds).toBeUndefined();
    });
  });

  test("rejects a replacement expectation when no mapping exists", async () => {
    await withStorage(async (first) => {
      await expect(first.adoptNativeAgentSession({
        ...input,
        providerSessionId: "provider-new",
        expectedProviderSessionId: "provider-old",
      })).rejects.toThrow("replacement target");
    });
  });

  test("acknowledges only the startup projection it actually persisted", async () => {
    await withStorage(async (first) => {
      await first.updateEnvironment("env-1", {
        startupAgentSession: {
          tabId: "startup-agent",
          agent: "codex",
          style: "native",
          providerSessionId: "provider-new",
          status: "running",
          startedAt: "2026-07-29T12:00:00.000Z",
        },
      });

      expect(
        (await first.acknowledgeStartupAgentSession(
          "env-1",
          "provider-old",
          "2026-07-29T11:00:00.000Z",
        )).startupAgentSession,
      ).toBeDefined();
      expect(
        (await first.acknowledgeStartupAgentSession(
          "env-1",
          "provider-new",
          "2026-07-29T12:00:00.000Z",
        )).startupAgentSession,
      ).toBeUndefined();
    });
  });
});
