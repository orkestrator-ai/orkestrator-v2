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

  test("lists nothing before any native session has been persisted", async () => {
    await withStorage(async (first) => {
      // The activity sweep lists on every tick from the very first backend
      // start, when no session file exists yet. A missing file has to read as
      // "no sessions" rather than as the failure that would make the sweep
      // warn every two seconds on a fresh install.
      await expect(fs.access(
        path.join(first.getDataDir(), "native-agent-sessions.json"),
      )).rejects.toThrow();
      await expect(first.listNativeAgentSessions()).resolves.toEqual([]);
    });
  });

  test("lists a session written by another backend process", async () => {
    await withStorage(async (first, second) => {
      const created = await first.getOrCreateNativeAgentSession(
        input,
        async () => "provider-session",
      );

      // The sweep reads durable state rather than a warm in-process cache, so
      // a second instance must see a session it never created itself.
      await expect(second.listNativeAgentSessions()).resolves.toEqual([created]);
    });
  });

  test("lists every valid provider session and filters malformed persisted entries", async () => {
    await withStorage(async (first) => {
      const inputs = [
        {
          ...input,
          key: "claude-session-key",
          agent: "claude" as const,
          logicalSessionKey: "env-env-1:claude-tab",
        },
        {
          ...input,
          key: "codex-session-key",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:codex-tab",
        },
        {
          ...input,
          key: "opencode-session-key",
          logicalSessionKey: "env-env-1:opencode-tab",
        },
      ];
      const expected = await Promise.all(inputs.map((session, index) =>
        first.getOrCreateNativeAgentSession(
          session,
          async () => `provider-${index + 1}`,
        )
      ));

      const file = path.join(first.getDataDir(), "native-agent-sessions.json");
      const stored = JSON.parse(await fs.readFile(file, "utf8")) as Record<
        string,
        unknown
      >;
      stored["mismatched-storage-key"] = {
        ...expected[0],
        key: "different-record-key",
      };
      stored["invalid-provider"] = {
        ...expected[1],
        key: "invalid-provider",
        agent: "gemini",
      };
      stored["missing-required-fields"] = { key: "missing-required-fields" };
      await fs.writeFile(file, JSON.stringify(stored));

      const listed = await first.listNativeAgentSessions();
      expect(listed).toEqual(expect.arrayContaining(expected));
      expect(listed).toHaveLength(3);
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

  test("refuses to reuse one key for a second logical identity", async () => {
    await withStorage(async (first) => {
      await first.addEnvironment({
        ...(await first.getEnvironment("env-1"))!,
        id: "env-2",
      });
      await first.getOrCreateNativeAgentSession(input, async () => "provider-session");
      const createProviderSession = mock(async () => "provider-other");

      // The key is a hash of environment, agent and logical key. A mismatch
      // means either a hash collision or a caller that built the key wrongly;
      // adopting the record would hand one tab another tab's session.
      for (const collision of [
        { ...input, logicalSessionKey: "env-env-1:other-tab" },
        { ...input, agent: "codex" as const },
        { ...input, environmentId: "env-2" },
      ]) {
        await expect(
          first.getOrCreateNativeAgentSession(collision, createProviderSession),
        ).rejects.toThrow("Native agent session key collision");
        await expect(first.adoptNativeAgentSession({
          ...collision,
          providerSessionId: "provider-other",
        })).rejects.toThrow("Native agent session key collision");
      }
      expect(createProviderSession).not.toHaveBeenCalled();
      expect((await first.getNativeAgentSession(input.key))?.providerSessionId)
        .toBe("provider-session");
    });
  });

  test("refuses a blank provider session id and persists nothing", async () => {
    await withStorage(async (first) => {
      for (const invalid of ["", "   "]) {
        await expect(
          first.getOrCreateNativeAgentSession(input, async () => invalid),
        ).rejects.toThrow("Provider returned an invalid native session ID");
      }
      expect(await first.getNativeAgentSession(input.key)).toBeNull();
    });
  });

  test("rejects blank and malformed native session identities", async () => {
    await withStorage(async (first) => {
      const create = async () => "provider-session";
      await expect(first.getNativeAgentSession("")).rejects.toThrow("must not be blank");
      await expect(first.getOrCreateNativeAgentSession({ ...input, key: " " }, create))
        .rejects.toThrow("Native agent session input is invalid");
      await expect(
        first.getOrCreateNativeAgentSession({ ...input, environmentId: "" }, create),
      ).rejects.toThrow("Native agent session input is invalid");
      await expect(
        first.getOrCreateNativeAgentSession({ ...input, logicalSessionKey: "" }, create),
      ).rejects.toThrow("Native agent session input is invalid");
      await expect(first.getOrCreateNativeAgentSession(
        { ...input, agent: "gemini" as unknown as typeof input.agent },
        create,
      )).rejects.toThrow("Native agent session input is invalid");

      await expect(first.adoptNativeAgentSession({
        ...input,
        providerSessionId: " ",
      })).rejects.toThrow("Native agent session adoption input is invalid");
      await expect(first.adoptNativeAgentSession({
        ...input,
        providerSessionId: "provider-session",
        expectedProviderSessionId: " ",
      })).rejects.toThrow("Native agent session adoption input is invalid");

      await expect(first.invalidateNativeAgentSession("", "provider-session"))
        .rejects.toThrow("identity must not be blank");
      await expect(first.invalidateNativeAgentSession(input.key, ""))
        .rejects.toThrow("identity must not be blank");
      await expect(first.dispatchNativeAgentPromptOnce("", "request-1", async () => undefined))
        .rejects.toThrow("dispatch key must not be blank");
      await expect(first.dispatchNativeAgentPromptOnce(input.key, " ", async () => undefined))
        .rejects.toThrow("dispatch key must not be blank");
    });
  });

  test("bounds the dispatched request id history at one thousand entries", async () => {
    await withStorage(async (first) => {
      await first.getOrCreateNativeAgentSession(input, async () => "provider-session");
      // Seeding the file is the only way to reach the bound without a thousand
      // real cross-process writes; the persisted validator caps it at 1000 too.
      const file = path.join(first.getDataDir(), "native-agent-sessions.json");
      const stored = JSON.parse(await fs.readFile(file, "utf8")) as Record<
        string,
        { dispatchedRequestIds?: string[] }
      >;
      stored[input.key]!.dispatchedRequestIds = Array.from(
        { length: 1_000 },
        (_, index) => `request-${index}`,
      );
      await fs.writeFile(file, JSON.stringify(stored));

      const { session } = await first.dispatchNativeAgentPromptOnce(
        input.key,
        "request-new",
        async () => undefined,
      );
      expect(session.dispatchedRequestIds).toHaveLength(1_000);
      expect(session.dispatchedRequestIds?.[0]).toBe("request-1");
      expect(session.dispatchedRequestIds?.at(-1)).toBe("request-new");
      // The oldest id was evicted, so replaying it is no longer suppressed.
      expect((await first.dispatchNativeAgentPromptOnce(
        input.key,
        "request-0",
        async () => undefined,
      )).dispatched).toBe(true);
      expect((await first.dispatchNativeAgentPromptOnce(
        input.key,
        "request-new",
        async () => undefined,
      )).dispatched).toBe(false);
    });
  });

  test("deletes only the sessions belonging to one environment", async () => {
    await withStorage(async (first) => {
      await first.addEnvironment({
        ...(await first.getEnvironment("env-1"))!,
        id: "env-2",
      });
      const other = {
        key: "native-session-key-2",
        environmentId: "env-2",
        agent: "codex" as const,
        logicalSessionKey: "env-env-2:startup-agent",
      };
      await first.getOrCreateNativeAgentSession(input, async () => "provider-1");
      await first.getOrCreateNativeAgentSession(other, async () => "provider-2");

      await first.deleteNativeAgentSessionsByEnvironment("env-1");

      expect(await first.getNativeAgentSession(input.key)).toBeNull();
      expect((await first.getNativeAgentSession(other.key))?.providerSessionId)
        .toBe("provider-2");
    });
  });

  test("scrubs a deleted environment's sessions out of retained backups", async () => {
    await withStorage(async (first) => {
      await first.addEnvironment({
        ...(await first.getEnvironment("env-1"))!,
        id: "env-2",
      });
      await first.getOrCreateNativeAgentSession(
        { ...input, environmentId: "env-2", key: "keep-key", logicalSessionKey: "KEEP-ME" },
        async () => "provider-keep",
      );
      // A second write rotates the primary file into a backup, so the deleted
      // environment's logical key and provider session id survive there unless
      // the delete scrubs them — every sibling delete-by-environment does.
      await first.getOrCreateNativeAgentSession(
        { ...input, logicalSessionKey: "DROP-ME" },
        async () => "provider-drop",
      );

      await first.deleteNativeAgentSessionsByEnvironment("env-1");

      const dataDir = first.getDataDir();
      const contents = await Promise.all(
        (await fs.readdir(dataDir))
          .filter((name) => name.startsWith("native-agent-sessions.json"))
          .map((name) => fs.readFile(path.join(dataDir, name), "utf8")),
      );
      const all = contents.join("\n");
      expect(all).toContain("KEEP-ME");
      expect(all).not.toContain("DROP-ME");
      expect(all).not.toContain("provider-drop");
    });
  });

  test("treats a blank or unknown environment as nothing to delete", async () => {
    await withStorage(async (first) => {
      await first.getOrCreateNativeAgentSession(input, async () => "provider-session");
      await first.deleteNativeAgentSessionsByEnvironment("");
      await first.deleteNativeAgentSessionsByEnvironment("env-never-existed");
      expect((await first.getNativeAgentSession(input.key))?.providerSessionId)
        .toBe("provider-session");
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
