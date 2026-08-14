import { describe, expect, jest, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AGENT_INTERACTION_CLAIM_RETENTION_MS,
  AGENT_INTERACTION_JOURNAL_VERSION,
  AGENT_INTERACTION_LIMITS,
  AGENT_INTERACTION_JOURNAL_RETENTION_MS,
  INTERACTIVE_AGENT_INTERACTION_POLICY,
  UNATTENDED_AGENT_INTERACTION_POLICY,
} from "@orkestrator/protocol/agent-interactions";
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

function terminalJournalEntry(index: number, resolvedAt = Date.now()) {
  return {
    id: `claim-${index}`,
    interactionId: `interaction-${index}`,
    provider: "codex" as const,
    kind: "command-approval" as const,
    sessionId: "provider-session",
    state: "workflow-recorded" as const,
    claim: {
      workflowType: "build-pipeline" as const,
      workflowId: "pipeline-1",
      phase: "building",
      fence: index,
      claimedAt: resolvedAt - 2,
    },
    outcome: "denied" as const,
    providerResolvedAt: resolvedAt - 1,
    workflowRecordedAt: resolvedAt,
  };
}

describe("StorageService native agent sessions", () => {
  test("migrates legacy sessions to interactive without losing identity or dispatch history", async () => {
    await withStorage(async (first) => {
      const dataDir = (await first.getEnvironment("env-1"))!.worktreePath!;
      const legacy = {
        [input.key]: {
          ...input,
          providerSessionId: "legacy-provider-session",
          dispatchedRequestIds: ["legacy-request"],
          createdAt: new Date(1).toISOString(),
          updatedAt: new Date(2).toISOString(),
        },
      };
      await fs.writeFile(
        path.join(dataDir, "native-agent-sessions.json"),
        JSON.stringify(legacy),
      );

      expect(await first.getNativeAgentSession(input.key)).toEqual({
        ...input,
        providerSessionId: "legacy-provider-session",
        dispatchedRequestIds: ["legacy-request"],
        createdAt: new Date(1).toISOString(),
        updatedAt: new Date(2).toISOString(),
        version: 1,
        origin: "interactive-native",
        interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
      });
    });
  });

  test("migrates legacy looped-review sessions to unattended without replacing the provider", async () => {
    await withStorage(async (first, second) => {
      const file = path.join(first.getDataDir(), "native-agent-sessions.json");
      const legacyInput = {
        ...input,
        logicalSessionKey: "looped-review:workflow-1:discovery:round-1",
      };
      await fs.writeFile(file, JSON.stringify({
        [input.key]: {
          ...legacyInput,
          providerSessionId: "legacy-provider-session",
          createdAt: new Date(1).toISOString(),
          updatedAt: new Date(2).toISOString(),
        },
      }));

      const migrated = await first.getOrCreateNativeAgentSession(
        {
          ...legacyInput,
          origin: "looped-review",
          interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
        },
        async () => "must-not-be-created",
      );
      expect(migrated).toMatchObject({
        providerSessionId: "legacy-provider-session",
        origin: "looped-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      });
      expect(JSON.parse(await fs.readFile(file, "utf8"))[input.key]).toMatchObject({
        version: 1,
        origin: "looped-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      });
      expect(await second.getNativeAgentSession(input.key)).toEqual(migrated);
    });
  });

  test("persists unattended origin and policy on newly created logical sessions", async () => {
    await withStorage(async (first) => {
      const saved = await first.getOrCreateNativeAgentSession({
        ...input,
        origin: "looped-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      }, async () => "provider-session");
      expect(saved).toMatchObject({
        version: 1,
        origin: "looped-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      });
      expect(await first.getNativeAgentSession(input.key)).toEqual(saved);
    });
  });

  test.each(["cursor", "grok"] as const)(
    "round-trips versioned %s sessions through the canonical agent allowlist",
    async (agent) => {
      await withStorage(async (first, second) => {
        const providerInput = {
          ...input,
          key: `${agent}-native-session-key`,
          agent,
          logicalSessionKey: `env-env-1:${agent}-tab`,
        };
        const saved = await first.getOrCreateNativeAgentSession(
          providerInput,
          async () => `${agent}-provider-session`,
        );

        expect(await first.getNativeAgentSession(providerInput.key)).toEqual(saved);
        expect(await second.getNativeAgentSession(providerInput.key)).toEqual(saved);
      });
    },
  );

  test("fails closed for malformed versioned metadata", async () => {
    await withStorage(async (first) => {
      const dataDir = (await first.getEnvironment("env-1"))!.worktreePath!;
      await fs.writeFile(
        path.join(dataDir, "native-agent-sessions.json"),
        JSON.stringify({
          [input.key]: {
            ...input,
            version: 1,
            providerSessionId: "provider-session",
            origin: "looped-review",
            interactionPolicy: { version: 1, mode: "unattended" },
            createdAt: new Date(1).toISOString(),
            updatedAt: new Date(2).toISOString(),
          },
        }),
      );
      await expect(first.getNativeAgentSession(input.key)).rejects.toThrow(
        "invalid or uses an unsupported version",
      );
    });
  });

  test("does not overwrite an unknown future session version", async () => {
    await withStorage(async (first) => {
      const file = path.join(first.getDataDir(), "native-agent-sessions.json");
      const future = {
        [input.key]: {
          ...input,
          version: 2,
          providerSessionId: "future-provider-session",
          origin: "interactive-native",
          interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
          createdAt: new Date(1).toISOString(),
          updatedAt: new Date(2).toISOString(),
        },
      };
      const original = JSON.stringify(future);
      await fs.writeFile(file, original);
      const create = mock(async () => "replacement-provider-session");

      await expect(first.getOrCreateNativeAgentSession(input, create))
        .rejects.toThrow("invalid or uses an unsupported version");
      expect(create).not.toHaveBeenCalled();
      expect(await fs.readFile(file, "utf8")).toBe(original);
    });
  });

  test("reads a session while another process holds the lock for a provider create", async () => {
    await withStorage(async (first, second) => {
      let releaseCreate!: () => void;
      const createBarrier = new Promise<void>((resolve) => {
        releaseCreate = resolve;
      });
      let signalCreating!: () => void;
      const creating = new Promise<void>((resolve) => {
        signalCreating = resolve;
      });

      // `getOrCreateNativeAgentSession` deliberately holds the cross-process
      // lock across the external create. A reattach read must not queue behind
      // it — the lock has a 20s deadline, so queuing would turn a slow provider
      // into a failed read for every other tab.
      const create = first.getOrCreateNativeAgentSession(input, async () => {
        signalCreating();
        await createBarrier;
        return "slow-provider-session";
      });
      await creating;

      expect(await second.getNativeAgentSession("unrelated-key")).toBeNull();
      releaseCreate();
      expect((await create).providerSessionId).toBe("slow-provider-session");
    });
  });

  test("persists a migration discovered on the read path", async () => {
    await withStorage(async (first) => {
      const file = path.join(first.getDataDir(), "native-agent-sessions.json");
      await fs.writeFile(file, JSON.stringify({
        [input.key]: {
          ...input,
          providerSessionId: "legacy-provider-session",
          createdAt: new Date(1).toISOString(),
          updatedAt: new Date(2).toISOString(),
        },
      }));

      // The read is lock-free until it finds something to migrate; then it must
      // take the lock and write, so the next process does not repeat the work.
      const migrated = await first.getNativeAgentSession(input.key);
      expect(migrated).toMatchObject({
        version: 1,
        origin: "interactive-native",
        interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
      });
      expect(JSON.parse(await fs.readFile(file, "utf8"))[input.key]).toEqual(migrated);
    });
  });

  test("confines an unreadable record to its own key", async () => {
    await withStorage(async (first) => {
      const file = path.join(first.getDataDir(), "native-agent-sessions.json");
      const readable = {
        ...input,
        key: "readable-key",
        version: 1 as const,
        providerSessionId: "readable-provider-session",
        origin: "interactive-native" as const,
        interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
        createdAt: new Date(1).toISOString(),
        updatedAt: new Date(2).toISOString(),
      };
      // Written by a newer build the user has since downgraded from, and
      // belonging to an environment this call knows nothing about.
      const future = {
        ...input,
        key: "poisoned-key",
        environmentId: "env-other",
        version: 2,
        providerSessionId: "future-provider-session",
        origin: "interactive-native",
        interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
        createdAt: new Date(1).toISOString(),
        updatedAt: new Date(2).toISOString(),
      };
      await fs.writeFile(file, JSON.stringify({
        "readable-key": readable,
        "poisoned-key": future,
      }));

      expect(await first.getNativeAgentSession("readable-key")).toEqual(readable);
      expect(await first.getNativeAgentSession("absent-key")).toBeNull();
      await expect(first.getNativeAgentSession("poisoned-key")).rejects.toThrow(
        "invalid or uses an unsupported version",
      );
      // The unreadable record must survive a write to a neighbouring key.
      await first.getOrCreateNativeAgentSession(
        { ...input, key: "new-key" },
        async () => "new-provider-session",
      );
      expect(JSON.parse(await fs.readFile(file, "utf8"))["poisoned-key"])
        .toEqual(future);
    });
  });

  test("deletes an environment while an unreadable record is present", async () => {
    await withStorage(async (first) => {
      const file = path.join(first.getDataDir(), "native-agent-sessions.json");
      const future = {
        ...input,
        key: "poisoned-key",
        environmentId: "env-other",
        version: 2,
        providerSessionId: "future-provider-session",
        origin: "interactive-native",
        interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
        createdAt: new Date(1).toISOString(),
        updatedAt: new Date(2).toISOString(),
      };
      const doomed = await first.getOrCreateNativeAgentSession(
        input,
        async () => "doomed-provider-session",
      );
      await fs.writeFile(file, JSON.stringify({
        [input.key]: doomed,
        "poisoned-key": future,
      }));

      // Deleting an environment is how a user clears a poisoned store, so it
      // must never be the operation that the poisoned record blocks.
      await first.deleteNativeAgentSessionsByEnvironment("env-1");
      const remaining = JSON.parse(await fs.readFile(file, "utf8"));
      expect(remaining[input.key]).toBeUndefined();
      expect(remaining["poisoned-key"]).toEqual(future);
    });
  });

  test("announces only a delete that removed something", async () => {
    await withStorage(async (first) => {
      const file = path.join(first.getDataDir(), "native-agent-sessions.json");
      await first.getOrCreateNativeAgentSession(input, async () => "provider-session");
      const announced: string[] = [];
      first.setResourceChangeListener((change) => {
        if (change.resource === "native-agent-session") announced.push(change.id);
      });

      await first.deleteNativeAgentSessionsByEnvironment("env-absent");
      expect(announced).toEqual([]);
      await first.deleteNativeAgentSessionsByEnvironment("env-1");
      expect(announced).toEqual(["env-1"]);
      expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({});
    });
  });

  test("rejects origin and policy combinations that weaken workflow authority", async () => {
    await withStorage(async (first) => {
      await expect(first.getOrCreateNativeAgentSession({
        ...input,
        origin: "looped-review",
        interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
      }, async () => "provider-session")).rejects.toThrow("input is invalid");
      await expect(first.adoptNativeAgentSession({
        ...input,
        providerSessionId: "provider-session",
        origin: "interactive-native",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      })).rejects.toThrow("adoption input is invalid");
    });
  });

  test("keeps a logical session policy fixed across provider replacement", async () => {
    await withStorage(async (first) => {
      await first.adoptNativeAgentSession({
        ...input,
        providerSessionId: "provider-old",
        origin: "looped-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      });
      const replacement = await first.adoptNativeAgentSession({
        ...input,
        providerSessionId: "provider-new",
        expectedProviderSessionId: "provider-old",
      });
      expect(replacement).toMatchObject({
        providerSessionId: "provider-new",
        origin: "looped-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      });
    });
  });

  test("round-trips a bounded content-free interaction resolution journal", async () => {
    await withStorage(async (first, second) => {
      const saved = await first.updateAgentInteractionResolutionJournal(
        (journal) => ({
          ...journal,
          entries: [{
            id: "claim-1",
            interactionId: "interaction-1",
            provider: "codex",
            kind: "command-approval",
            sessionId: "provider-session",
            state: "claimed",
            claim: {
              workflowType: "build-pipeline",
              workflowId: "pipeline-1",
              phase: "building",
              fence: 4,
              claimedAt: Date.now(),
            },
          }],
        }),
      );
      expect(saved.version).toBe(AGENT_INTERACTION_JOURNAL_VERSION);
      expect(await second.getAgentInteractionResolutionJournal()).toEqual(saved);
      expect(JSON.stringify(saved)).not.toContain("prompt");
      expect(JSON.stringify(saved)).not.toContain("answer");
    });
  });

  test("serializes concurrent journal updates across storage instances", async () => {
    await withStorage(async (first, second) => {
      await Promise.all([
        first.updateAgentInteractionResolutionJournal((journal) => ({
          ...journal,
          entries: [...journal.entries, terminalJournalEntry(1)],
        })),
        second.updateAgentInteractionResolutionJournal((journal) => ({
          ...journal,
          entries: [...journal.entries, terminalJournalEntry(2)],
        })),
      ]);
      expect((await first.getAgentInteractionResolutionJournal()).entries
        .map((entry) => entry.id).sort()).toEqual(["claim-1", "claim-2"]);
    });
  });

  test("orders a journal read against an in-flight update", async () => {
    await withStorage(async (first, second) => {
      let releaseUpdate!: () => void;
      const barrier = new Promise<void>((resolve) => {
        releaseUpdate = resolve;
      });
      const update = first.updateAgentInteractionResolutionJournal((journal) => {
        // The updater runs while the lock is held; the read must not observe
        // the pre-update journal after this point.
        queueMicrotask(releaseUpdate);
        return {
          ...journal,
          entries: [...journal.entries, terminalJournalEntry(7)],
        };
      });
      await barrier;
      const [updated, read] = await Promise.all([
        update,
        second.getAgentInteractionResolutionJournal(),
      ]);
      expect(updated.entries.map((entry) => entry.id)).toEqual(["claim-7"]);
      expect(read).toEqual(updated);
    });
  });

  test("reclaims an abandoned claim rather than wedging the journal", async () => {
    await withStorage(async (first) => {
      const file = path.join(
        first.getDataDir(),
        "agent-interaction-resolution-journal.json",
      );
      const claimedAt = Date.now() - AGENT_INTERACTION_CLAIM_RETENTION_MS - 1;
      await fs.writeFile(file, JSON.stringify({
        version: AGENT_INTERACTION_JOURNAL_VERSION,
        entries: [{
          ...terminalJournalEntry(1),
          state: "claimed",
          claim: { ...terminalJournalEntry(1).claim, claimedAt },
          outcome: undefined,
          providerResolvedAt: undefined,
          workflowRecordedAt: undefined,
        }],
      }));
      const read = await first.getAgentInteractionResolutionJournal();
      expect(read.entries).toHaveLength(1);
      expect(read.entries[0]).toMatchObject({
        state: "workflow-recorded",
        outcome: "stale",
      });
    });
  });

  test("rolls terminal journal history over at the configured bound", async () => {
    await withStorage(async (first) => {
      const entries = Array.from(
        { length: AGENT_INTERACTION_LIMITS.maxJournalEntries },
        (_, index) => terminalJournalEntry(index, Date.now() + index),
      );
      await first.updateAgentInteractionResolutionJournal((journal) => ({
        ...journal,
        entries,
      }));
      const rolled = await first.updateAgentInteractionResolutionJournal((journal) => ({
        ...journal,
        entries: [...journal.entries, terminalJournalEntry(entries.length, Date.now() + entries.length)],
      }));
      expect(rolled.entries).toHaveLength(AGENT_INTERACTION_LIMITS.maxJournalEntries);
      expect(rolled.entries.some((entry) => entry.id === "claim-0")).toBe(false);
      expect(rolled.entries.some((entry) => entry.id === `claim-${entries.length}`))
        .toBe(true);
    });
  });

  test("rejects malformed journals and invalid updater results", async () => {
    await withStorage(async (first) => {
      const file = path.join(
        first.getDataDir(),
        "agent-interaction-resolution-journal.json",
      );
      await fs.writeFile(file, JSON.stringify({ version: 1, entries: [{}] }));
      await expect(first.getAgentInteractionResolutionJournal()).rejects.toThrow(
        "journal is invalid",
      );
      await fs.writeFile(file, JSON.stringify({ version: 1, entries: [] }));
      await expect(first.updateAgentInteractionResolutionJournal(() => ({
        version: 2,
        entries: [],
      } as never))).rejects.toThrow("cleanup input");
    });
  });

  test("persists journal cleanup with restricted permissions", async () => {
    await withStorage(async (first) => {
      const file = path.join(
        first.getDataDir(),
        "agent-interaction-resolution-journal.json",
      );
      const expiredAt = Date.now() - AGENT_INTERACTION_JOURNAL_RETENTION_MS - 1;
      await fs.writeFile(file, JSON.stringify({
        version: AGENT_INTERACTION_JOURNAL_VERSION,
        entries: [terminalJournalEntry(1, expiredAt)],
      }));
      await first.updateAgentInteractionResolutionJournal((journal) => journal);
      expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
        version: AGENT_INTERACTION_JOURNAL_VERSION,
        entries: [],
      });
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    });
  });

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

  test("preserves the first ambiguous dispatch and rejects a competing request", async () => {
    await withStorage(async (first) => {
      await first.getOrCreateNativeAgentSession(input, async () => "provider-session");
      const pendingA = {
        requestId: "request-a",
        prompt: "first prompt",
        attachments: [{
          type: "file" as const,
          path: "/workspace/first.txt",
          dataUrl: "data:text/plain;base64,Zmlyc3Q=",
        }],
        createdAt: new Date(1).toISOString(),
      };
      await expect(first.dispatchNativeAgentPromptOnce(
        input.key,
        pendingA.requestId,
        async () => { throw new Error("acknowledgement lost"); },
        pendingA,
      )).rejects.toThrow("acknowledgement lost");

      const competingDispatch = mock(async () => undefined);
      await expect(first.dispatchNativeAgentPromptOnce(
        input.key,
        "request-b",
        competingDispatch,
        {
          requestId: "request-b",
          prompt: "second prompt",
          createdAt: new Date(2).toISOString(),
        },
      )).rejects.toThrow("request-a is still awaiting recovery");
      expect(competingDispatch).not.toHaveBeenCalled();
      expect((await first.getNativeAgentSession(input.key))?.pendingDispatch)
        .toEqual(pendingA);
    });
  });

  test("scrubs resolved and invalidated dispatch content from every retained backup", async () => {
    await withStorage(async (first) => {
      await first.getOrCreateNativeAgentSession(input, async () => "provider-session");
      const file = path.join(first.getDataDir(), "native-agent-sessions.json");
      const allNativeSessionFiles = async () => Promise.all(
        (await fs.readdir(first.getDataDir()))
          .filter((name) => name.startsWith("native-agent-sessions.json"))
          .map((name) => fs.readFile(path.join(first.getDataDir(), name), "utf8")),
      );

      const acceptedSecret = "ACCEPTED-PROMPT-AND-ATTACHMENT-CONTENT";
      await first.dispatchNativeAgentPromptOnce(
        input.key,
        "accepted",
        async () => undefined,
        {
          requestId: "accepted",
          prompt: acceptedSecret,
          attachments: [{
            type: "image",
            path: "/workspace/accepted.png",
            dataUrl: `data:image/png;base64,${acceptedSecret}`,
          }],
          createdAt: new Date(1).toISOString(),
        },
      );
      expect((await allNativeSessionFiles()).join("\n")).not.toContain(acceptedSecret);

      const clearedSecret = "CLEARED-PROMPT-CONTENT";
      await expect(first.dispatchNativeAgentPromptOnce(
        input.key,
        "cleared",
        async () => { throw new Error("ambiguous"); },
        {
          requestId: "cleared",
          prompt: clearedSecret,
          createdAt: new Date(2).toISOString(),
        },
      )).rejects.toThrow("ambiguous");
      expect(await first.clearPendingNativeAgentDispatch(input.key, "cleared")).toBe(true);
      expect((await allNativeSessionFiles()).join("\n")).not.toContain(clearedSecret);

      const invalidatedSecret = "INVALIDATED-PROMPT-CONTENT";
      await expect(first.dispatchNativeAgentPromptOnce(
        input.key,
        "invalidated",
        async () => { throw new Error("ambiguous"); },
        {
          requestId: "invalidated",
          prompt: invalidatedSecret,
          createdAt: new Date(3).toISOString(),
        },
      )).rejects.toThrow("ambiguous");
      expect(await first.invalidateNativeAgentSession(input.key, "provider-session")).toBe(true);
      expect((await allNativeSessionFiles()).join("\n")).not.toContain(invalidatedSecret);
      expect(await fs.readFile(file, "utf8")).not.toContain(input.key);
    });
  });

  test("bounds pending dispatches before provider I/O and round-trips accepted records", async () => {
    await withStorage(async (first) => {
      await first.getOrCreateNativeAgentSession(input, async () => "provider-session");
      const dispatch = mock(async () => undefined);
      await expect(first.dispatchNativeAgentPromptOnce(
        input.key,
        "oversized",
        dispatch,
        {
          requestId: "oversized",
          prompt: "x".repeat(32 * 1024 * 1024),
          createdAt: new Date(1).toISOString(),
        },
      )).rejects.toThrow("exceeds the 32 MB limit");
      expect(dispatch).not.toHaveBeenCalled();
      expect((await first.getNativeAgentSession(input.key))?.pendingDispatch).toBeUndefined();

      const recoverable = {
        requestId: "recoverable",
        prompt: "round-trip prompt",
        schema: { type: "object" },
        attachments: [{
          type: "image" as const,
          path: "/workspace/round-trip.png",
          dataUrl: "data:image/png;base64,cG5n",
        }],
        createdAt: new Date(2).toISOString(),
      };
      await expect(first.dispatchNativeAgentPromptOnce(
        input.key,
        recoverable.requestId,
        async () => { throw new Error("ambiguous"); },
        recoverable,
      )).rejects.toThrow("ambiguous");
      const restarted = new StorageService(first.getDataDir());
      await restarted.init();
      expect((await restarted.getNativeAgentSession(input.key))?.pendingDispatch)
        .toEqual(recoverable);
    });
  });

  test("persists recovery notices without journaling and clears them on dispatch", async () => {
    await withStorage(async (first) => {
      await first.getOrCreateNativeAgentSession(input, async () => "provider-session");
      const notice = {
        kind: "exhausted" as const,
        assistantMessageId: "assistant-1",
        updatedAt: "2026-08-10T10:00:00.000Z",
      };
      const skipped = await first.dispatchNativeAgentPromptOnce(
        input.key,
        "recovery-1",
        async () => ({ dispatched: false, openCodeIncompleteTurnNotice: notice }),
      );
      expect(skipped.dispatched).toBe(false);
      expect(skipped.session.dispatchedRequestIds).toBeUndefined();
      expect(skipped.session.openCodeIncompleteTurnNotice).toEqual(notice);

      const accepted = await first.dispatchNativeAgentPromptOnce(
        input.key,
        "manual-1",
        async () => undefined,
      );
      expect(accepted.dispatched).toBe(true);
      expect(accepted.session.openCodeIncompleteTurnNotice).toBeUndefined();
      expect(accepted.session.dispatchedRequestIds).toEqual(["manual-1"]);
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
        controls: {
          modelId: "old-model",
          mode: "build",
          includeLocalSettings: false,
        },
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
        controls: {
          modelId: "new-model",
          executionProfileId: "reviewer",
          includeLocalSettings: true,
          promptSuggestions: true,
        },
      });
      expect(replaced.providerSessionId).toBe("provider-new");
      expect(replaced.dispatchedRequestIds).toBeUndefined();
      expect(replaced.controls).toEqual({
        modelId: "new-model",
        mode: "build",
        executionProfileId: "reviewer",
        includeLocalSettings: true,
        promptSuggestions: true,
      });
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

  test("drops unrecognized session records from sensitive backups", async () => {
    await withStorage(async (first) => {
      await first.getOrCreateNativeAgentSession(input, async () => "provider-current");
      const backup = path.join(first.getDataDir(), "native-agent-sessions.json.bak.1");
      await fs.writeFile(backup, JSON.stringify({
        future: {
          ...input,
          key: "future",
          version: 2,
          logicalSessionKey: "DROP-FUTURE-METADATA",
          providerSessionId: "provider-future",
          origin: "interactive-native",
          interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
          createdAt: new Date(1).toISOString(),
          updatedAt: new Date(2).toISOString(),
        },
      }));

      await first.deleteNativeAgentSessionsByEnvironment("env-1");
      const scrubbed = await fs.readFile(backup, "utf8");
      expect(scrubbed).not.toContain("DROP-FUTURE-METADATA");
      expect(scrubbed).not.toContain("provider-future");
      expect(JSON.parse(scrubbed)).toEqual({});
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
