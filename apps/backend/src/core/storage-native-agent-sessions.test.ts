import { describe, expect, jest, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
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
import {
  PendingNativeAgentDispatchError,
  PendingNativeAgentSteerError,
  StorageService,
} from "./storage.js";
import { createNativeAgentDisplayTail } from "./native-agent-display-tails.js";
import { sessionIncompleteTurnNotice } from "./models.js";
import { STORAGE_DATABASE_FILE } from "./storage-database.js";
import {
  hasStore,
  readStoredValue,
  seedStore,
  storageFilesContain,
  writeLegacyStore,
} from "./storage-test-support.js";
import { NativeAgentSessionsRepository } from "./storage-native.js";

const SESSIONS_STORE = "native-agent-sessions.json";
const JOURNAL_STORE = "agent-interaction-resolution-journal.json";

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

/**
 * Two backends opening a data directory upgraded from the JSON stores, whose
 * native sessions were written by an older build. The import upgrades them
 * once (storage-record-upgrades.ts).
 */
async function withLegacySessions(
  legacy: Record<string, unknown>,
  run: (first: StorageService, second: StorageService, dataDir: string) => Promise<void>,
): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-native-legacy-"));
  writeLegacyStore(dataDir, "environments.json", [
    {
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
    },
  ]);
  writeLegacyStore(dataDir, SESSIONS_STORE, legacy);
  const first = new StorageService(dataDir);
  const second = new StorageService(dataDir);
  await Promise.all([first.init(), second.init()]);
  try {
    await run(first, second, dataDir);
  } finally {
    first.close();
    second.close();
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
    const legacy = {
      [input.key]: {
        ...input,
        providerSessionId: "legacy-provider-session",
        dispatchedRequestIds: ["legacy-request"],
        createdAt: new Date(1).toISOString(),
        updatedAt: new Date(2).toISOString(),
      },
    };
    await withLegacySessions(legacy, async (first) => {
      expect(await first.getNativeAgentSession(input.key)).toEqual({
        ...input,
        providerSessionId: "legacy-provider-session",
        dispatchedRequestIds: ["legacy-request"],
        createdAt: new Date(1).toISOString(),
        updatedAt: new Date(2).toISOString(),
        version: 1,
        origin: "interactive-native",
        interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
        // Start-up also backfills the owner of a session whose environment exists.
        owner: { kind: "environment", projectId: "project-1", environmentId: "env-1" },
      });
    });
  });

  test("persists unattended origin and policy on newly created logical sessions", async () => {
    await withStorage(async (first) => {
      const saved = await first.getOrCreateNativeAgentSession(
        {
          ...input,
          origin: "build-pipeline",
          interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
        },
        async () => "provider-session",
      );
      expect(saved).toMatchObject({
        version: 1,
        origin: "build-pipeline",
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
      seedStore(dataDir, SESSIONS_STORE, {
        [input.key]: {
          ...input,
          version: 1,
          providerSessionId: "provider-session",
          origin: "build-pipeline",
          interactionPolicy: { version: 1, mode: "unattended" },
          createdAt: new Date(1).toISOString(),
          updatedAt: new Date(2).toISOString(),
        },
      });
      await expect(first.getNativeAgentSession(input.key)).rejects.toThrow(
        "invalid or uses an unsupported version",
      );
    });
  });

  test("does not overwrite an unknown future session version", async () => {
    await withStorage(async (first) => {
      const dataDir = first.getDataDir();
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
      seedStore(dataDir, SESSIONS_STORE, future);
      const create = mock(async () => "replacement-provider-session");

      await expect(first.getOrCreateNativeAgentSession(input, create)).rejects.toThrow(
        "invalid or uses an unsupported version",
      );
      expect(create).not.toHaveBeenCalled();
      expect(readStoredValue(dataDir, SESSIONS_STORE)).toEqual(future);
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

  test("persists the legacy upgrade once at import, before any read", async () => {
    const legacy = {
      [input.key]: {
        ...input,
        providerSessionId: "legacy-provider-session",
        createdAt: new Date(1).toISOString(),
        updatedAt: new Date(2).toISOString(),
      },
    };
    await withLegacySessions(legacy, async (first, _second, dataDir) => {
      // No read path upgrades or writes anymore: the stored record is already
      // current, so a lock-free read never needs a lease.
      expect(
        readStoredValue<Record<string, unknown>>(dataDir, SESSIONS_STORE)?.[input.key],
      ).toMatchObject({
        version: 1,
        origin: "interactive-native",
        interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
      });
      expect(await first.getNativeAgentSession(input.key)).toEqual(
        readStoredValue<Record<string, unknown>>(dataDir, SESSIONS_STORE)?.[input.key] as never,
      );
    });
  });

  test("confines an unreadable record to its own key", async () => {
    await withStorage(async (first) => {
      const dataDir = first.getDataDir();
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
      seedStore(dataDir, SESSIONS_STORE, {
        "readable-key": readable,
        "poisoned-key": future,
      });

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
      expect(
        readStoredValue<Record<string, unknown>>(dataDir, SESSIONS_STORE)?.["poisoned-key"],
      ).toEqual(future);
    });
  });

  test("deletes an environment while an unreadable record is present", async () => {
    await withStorage(async (first) => {
      const dataDir = first.getDataDir();
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
      seedStore(dataDir, SESSIONS_STORE, {
        [input.key]: doomed,
        "poisoned-key": future,
      });

      // Deleting an environment is how a user clears a poisoned store, so it
      // must never be the operation that the poisoned record blocks.
      await first.deleteNativeAgentSessionsByEnvironment("env-1");
      const remaining = readStoredValue<Record<string, unknown>>(dataDir, SESSIONS_STORE)!;
      expect(remaining[input.key]).toBeUndefined();
      expect(remaining["poisoned-key"]).toEqual(future);
    });
  });

  test("announces only a delete that removed something", async () => {
    await withStorage(async (first) => {
      const dataDir = first.getDataDir();
      await first.getOrCreateNativeAgentSession(input, async () => "provider-session");
      const announced: string[] = [];
      first.setResourceChangeListener((change) => {
        if (change.resource === "native-agent-session") announced.push(change.id);
      });

      await first.deleteNativeAgentSessionsByEnvironment("env-absent");
      expect(announced).toEqual([]);
      await first.deleteNativeAgentSessionsByEnvironment("env-1");
      expect(announced).toEqual(["env-1"]);
      expect(readStoredValue(dataDir, SESSIONS_STORE)).toEqual({});
    });
  });

  test("rejects origin and policy combinations that weaken workflow authority", async () => {
    await withStorage(async (first) => {
      await expect(
        first.getOrCreateNativeAgentSession(
          {
            ...input,
            origin: "build-pipeline",
            interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
          },
          async () => "provider-session",
        ),
      ).rejects.toThrow("input is invalid");
      await expect(
        first.adoptNativeAgentSession({
          ...input,
          providerSessionId: "provider-session",
          origin: "interactive-native",
          interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
        }),
      ).rejects.toThrow("adoption input is invalid");
    });
  });

  test("keeps a logical session policy fixed across provider replacement", async () => {
    await withStorage(async (first) => {
      await first.adoptNativeAgentSession({
        ...input,
        providerSessionId: "provider-old",
        origin: "build-pipeline",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      });
      const replacement = await first.adoptNativeAgentSession({
        ...input,
        providerSessionId: "provider-new",
        expectedProviderSessionId: "provider-old",
      });
      expect(replacement).toMatchObject({
        providerSessionId: "provider-new",
        origin: "build-pipeline",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      });
    });
  });

  test("round-trips a bounded content-free interaction resolution journal", async () => {
    await withStorage(async (first, second) => {
      const saved = await first.updateAgentInteractionResolutionJournal((journal) => ({
        ...journal,
        entries: [
          {
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
          },
        ],
      }));
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
      expect(
        (await first.getAgentInteractionResolutionJournal()).entries
          .map((entry) => entry.id)
          .sort(),
      ).toEqual(["claim-1", "claim-2"]);
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
      const claimedAt = Date.now() - AGENT_INTERACTION_CLAIM_RETENTION_MS - 1;
      const {
        outcome: _outcome,
        providerResolvedAt: _resolved,
        workflowRecordedAt: _recorded,
        ...claimed
      } = terminalJournalEntry(1);
      seedStore(first.getDataDir(), JOURNAL_STORE, {
        version: AGENT_INTERACTION_JOURNAL_VERSION,
        entries: [{ ...claimed, state: "claimed", claim: { ...claimed.claim, claimedAt } }],
      });
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
        entries: [
          ...journal.entries,
          terminalJournalEntry(entries.length, Date.now() + entries.length),
        ],
      }));
      expect(rolled.entries).toHaveLength(AGENT_INTERACTION_LIMITS.maxJournalEntries);
      expect(rolled.entries.some((entry) => entry.id === "claim-0")).toBe(false);
      expect(rolled.entries.some((entry) => entry.id === `claim-${entries.length}`)).toBe(true);
    });
  });

  test("rejects malformed journals and invalid updater results", async () => {
    await withStorage(async (first) => {
      const dataDir = first.getDataDir();
      seedStore(dataDir, JOURNAL_STORE, { version: 1, entries: [{}] });
      await expect(first.getAgentInteractionResolutionJournal()).rejects.toThrow(
        "journal is invalid",
      );
      seedStore(dataDir, JOURNAL_STORE, { version: 1, entries: [] });
      await expect(
        first.updateAgentInteractionResolutionJournal(
          () =>
            ({
              version: 2,
              entries: [],
            }) as never,
        ),
      ).rejects.toThrow("cleanup input");
    });
  });

  test("persists journal cleanup with restricted permissions", async () => {
    await withStorage(async (first) => {
      const dataDir = first.getDataDir();
      const expiredAt = Date.now() - AGENT_INTERACTION_JOURNAL_RETENTION_MS - 1;
      seedStore(dataDir, JOURNAL_STORE, {
        version: AGENT_INTERACTION_JOURNAL_VERSION,
        entries: [terminalJournalEntry(1, expiredAt)],
      });
      await first.updateAgentInteractionResolutionJournal((journal) => journal);
      expect(readStoredValue(dataDir, JOURNAL_STORE)).toEqual({
        version: AGENT_INTERACTION_JOURNAL_VERSION,
        entries: [],
      });
      expect((await fs.stat(path.join(dataDir, STORAGE_DATABASE_FILE))).mode & 0o777).toBe(0o600);
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
        const held = first.runWithLiveEnvironment("env-1", "Held operation", async () => {
          signalEntered();
          await operationBarrier;
        });
        await entered;

        // Move beyond the stale-lock threshold. The 5-second heartbeat must
        // keep the lease fresh so another process cannot steal it.
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
        // Real I/O round trips give the contender's lease polling a chance to
        // run (and wrongly succeed) while the fake clock is past the threshold.
        for (let attempt = 0; attempt < 10; attempt += 1) {
          await fs.stat(first.getDataDir()).catch(() => undefined);
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

  test("budgets the native agent lock for a holder that spans provider I/O", async () => {
    // This lock is deliberately held across provider calls: a dispatch keeps it
    // until the provider acknowledges the request id, and a session create keeps
    // it across the external create so two processes cannot mint two provider
    // sessions. The worst legitimate holder is a cold ACP session create — four
    // 30s attempts plus 1.75s of backoff — so a waiter budgeted for a JSON write
    // would fail against a perfectly healthy holder.
    const budget = NativeAgentSessionsRepository.NATIVE_AGENT_SESSION_LOCK_TIMEOUT_MS;
    expect(budget).toBeGreaterThan(4 * 30_000 + 1_750);
  });

  test("completes deletion's session cleanup queued behind an in-flight dispatch", async () => {
    await withStorage(async (first, second) => {
      await first.getOrCreateNativeAgentSession(input, async () => "provider-session");
      let signalDispatchEntered!: () => void;
      const dispatchEntered = new Promise<void>((resolve) => {
        signalDispatchEntered = resolve;
      });
      let releaseSend!: () => void;
      const sendBarrier = new Promise<void>((resolve) => {
        releaseSend = resolve;
      });

      try {
        const dispatch = first.dispatchNativeAgentPromptOnce(input.key, "request-1", async () => {
          signalDispatchEntered();
          await sendBarrier;
        });
        await dispatchEntered;

        // Environment deletion runs this from whichever process owns the delete
        // command, and its caller can only log the failure — aborting there would
        // strand the environment record itself. So a rejection here is how a
        // deleted environment keeps its session record, its provider session id
        // and its pending prompt on disk after the user asked for it to go away.
        let cleanupSettled = false;
        const cleanup = second.deleteNativeAgentSessionsByEnvironment("env-1").then(() => {
          cleanupSettled = true;
        });
        for (let attempt = 0; attempt < 20; attempt += 1) await Promise.resolve();
        expect(cleanupSettled).toBe(false);

        releaseSend();
        await dispatch;
        await cleanup;
        await expect(second.listNativeAgentSessions()).resolves.toEqual([]);
        await expect(first.getNativeAgentSession(input.key)).resolves.toBeNull();
      } finally {
        releaseSend();
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
      // start, when no session store exists yet. A missing store has to read as
      // "no sessions" rather than as the failure that would make the sweep
      // warn every two seconds on a fresh install.
      expect(hasStore(first.getDataDir(), SESSIONS_STORE)).toBe(false);
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
      const expected = await Promise.all(
        inputs.map((session, index) =>
          first.getOrCreateNativeAgentSession(session, async () => `provider-${index + 1}`),
        ),
      );

      const dataDir = first.getDataDir();
      const stored = readStoredValue<Record<string, unknown>>(dataDir, SESSIONS_STORE)!;
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
      seedStore(dataDir, SESSIONS_STORE, stored);

      const listed = await first.listNativeAgentSessions();
      expect(listed).toEqual(expect.arrayContaining(expected));
      expect(listed).toHaveLength(3);
    });
  });

  test("persists mail refusal for cleanup, but invalidates it before a same-ID ambiguous retry", async () => {
    await withStorage(async (first, second) => {
      await first.getOrCreateNativeAgentSession(input, async () => "provider-session");
      const pending = {
        requestId: "mail-refused",
        prompt: "Mail",
        createdAt: new Date(0).toISOString(),
      };
      await first.dispatchNativeAgentPromptOnce(
        input.key,
        pending.requestId,
        async () => ({ dispatched: false, mailRefused: true }),
        pending,
      );
      expect((await second.getNativeAgentSession(input.key))?.pendingDispatch).toMatchObject({
        ...pending,
        mailRefused: true,
      });
      await expect(
        second.dispatchNativeAgentPromptOnce(input.key, "another-request", async () => undefined),
      ).rejects.toBeInstanceOf(PendingNativeAgentDispatchError);
      await expect(
        second.dispatchNativeAgentPromptOnce(input.key, pending.requestId, async (session) => {
          expect(session.pendingDispatch?.mailRefused).toBeUndefined();
          throw new Error("Lost acknowledgement");
        }),
      ).rejects.toThrow("Lost acknowledgement");
      expect(await first.clearPendingNativeAgentDispatch(input.key, pending.requestId, true)).toBe(
        false,
      );
      expect((await first.getNativeAgentSession(input.key))?.pendingDispatch).toMatchObject(
        pending,
      );
      // A later explicit refusal restores the durable cleanup proof.
      await second.dispatchNativeAgentPromptOnce(
        input.key,
        pending.requestId,
        async () => ({ dispatched: false, mailRefused: true }),
        pending,
      );
      expect(await first.clearPendingNativeAgentDispatch(input.key, pending.requestId, true)).toBe(
        true,
      );
      expect((await second.getNativeAgentSession(input.key))?.pendingDispatch).toBeUndefined();
      await second.dispatchNativeAgentPromptOnce(
        input.key,
        "another-request",
        async () => undefined,
      );
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
      expect((await first.getNativeAgentSession(input.key))?.dispatchedRequestIds).toEqual([
        "request-1",
      ]);
    });
  });

  test("preserves the first ambiguous dispatch and rejects a competing request", async () => {
    await withStorage(async (first) => {
      await first.getOrCreateNativeAgentSession(input, async () => "provider-session");
      const pendingA = {
        requestId: "request-a",
        prompt: "first prompt",
        attachments: [
          {
            type: "file" as const,
            path: "/workspace/first.txt",
            dataUrl: "data:text/plain;base64,Zmlyc3Q=",
          },
        ],
        createdAt: new Date(1).toISOString(),
      };
      await expect(
        first.dispatchNativeAgentPromptOnce(
          input.key,
          pendingA.requestId,
          async () => {
            throw new Error("acknowledgement lost");
          },
          pendingA,
        ),
      ).rejects.toThrow("acknowledgement lost");

      const competingDispatch = mock(async () => undefined);
      await expect(
        first.dispatchNativeAgentPromptOnce(input.key, "request-b", competingDispatch, {
          requestId: "request-b",
          prompt: "second prompt",
          createdAt: new Date(2).toISOString(),
        }),
      ).rejects.toThrow("request-a is still awaiting recovery");
      expect(competingDispatch).not.toHaveBeenCalled();
      expect((await first.getNativeAgentSession(input.key))?.pendingDispatch).toEqual(pendingA);
    });
  });

  test("persists one bounded steer barrier and reuses its backend identity exactly", async () => {
    await withStorage(async (first, second) => {
      await first.getOrCreateNativeAgentSession(input, async () => "provider-session");
      const text = "x".repeat(64 * 1024);
      const pending = {
        requestId: "steer-a",
        text,
        inputDigest: createHash("sha256").update(text).digest("hex"),
        expectedRunId: "pi:generation:1",
        state: "prepared" as const,
        createdAt: new Date(1).toISOString(),
      };
      const firstDispatch = mock(async () => ({
        outcome: "unknown" as const,
        requestId: pending.requestId,
      }));
      await expect(
        first.dispatchNativeAgentSteerOnce(input.key, pending, firstDispatch),
      ).resolves.toEqual({ outcome: "unknown", requestId: pending.requestId });
      expect(firstDispatch).toHaveBeenCalledTimes(1);
      expect((await second.getNativeAgentSession(input.key))?.pendingSteer).toMatchObject({
        ...pending,
        state: "unknown",
      });

      const competing = { ...pending, requestId: "steer-b" };
      const refusal = await second
        .dispatchNativeAgentSteerOnce(input.key, competing, async () => ({ outcome: "applied" }))
        .catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(PendingNativeAgentSteerError);
      expect((refusal as PendingNativeAgentSteerError).pendingRequestId).toBe("steer-a");

      const exactRetry = mock(async () => ({ outcome: "applied" as const }));
      await expect(
        second.dispatchNativeAgentSteerOnce(input.key, pending, exactRetry),
      ).resolves.toEqual({ outcome: "applied" });
      expect(exactRetry).toHaveBeenCalledTimes(1);
      const confirmedSession = await first.getNativeAgentSession(input.key);
      expect(confirmedSession?.pendingSteer).toBeUndefined();
      expect(confirmedSession?.dispatchedRequestIds).toEqual([pending.requestId]);
      expect(confirmedSession?.lastDispatchedTurn?.requestId).toBe(pending.requestId);

      const escapedText = '"'.repeat(64 * 1024);
      const escapedPending = {
        ...pending,
        requestId: "steer-escaped",
        text: escapedText,
        inputDigest: createHash("sha256").update(escapedText).digest("hex"),
      };
      const escapedDispatch = mock(async () => ({ outcome: "applied" as const }));
      await expect(
        first.dispatchNativeAgentSteerOnce(input.key, escapedPending, escapedDispatch),
      ).resolves.toEqual({ outcome: "applied" });
      expect(escapedDispatch).toHaveBeenCalledTimes(1);

      const oversizedText = `${text}x`;
      const oversizedDispatch = mock(async () => ({ outcome: "applied" as const }));
      await expect(
        first.dispatchNativeAgentSteerOnce(
          input.key,
          {
            ...pending,
            requestId: "steer-oversized",
            text: oversizedText,
            inputDigest: createHash("sha256").update(oversizedText).digest("hex"),
          },
          oversizedDispatch,
        ),
      ).rejects.toThrow("steer record is invalid");
      expect(oversizedDispatch).not.toHaveBeenCalled();
    });
  });

  test("names the parked request when it refuses a competing dispatch", async () => {
    await withStorage(async (first) => {
      await first.getOrCreateNativeAgentSession(input, async () => "provider-session");
      await expect(
        first.dispatchNativeAgentPromptOnce(
          input.key,
          "request-a",
          async () => {
            throw new Error("acknowledgement lost");
          },
          {
            requestId: "request-a",
            prompt: "first prompt",
            mode: "plan",
            createdAt: new Date(1).toISOString(),
          },
        ),
      ).rejects.toThrow("acknowledgement lost");

      // Callers have to be able to settle the *blocking* request, not just
      // learn that something blocked them.
      const refusal = await first
        .dispatchNativeAgentPromptOnce(input.key, "request-b", async () => undefined)
        .catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(PendingNativeAgentDispatchError);
      expect((refusal as PendingNativeAgentDispatchError).pendingRequestId).toBe("request-a");
    });
  });

  test("confirms a parked dispatch as spent instead of merely clearing it", async () => {
    await withStorage(async (first) => {
      await first.getOrCreateNativeAgentSession(input, async () => "provider-session");
      await expect(
        first.dispatchNativeAgentPromptOnce(
          input.key,
          "request-a",
          async () => {
            throw new Error("acknowledgement lost");
          },
          {
            requestId: "request-a",
            prompt: "first prompt",
            mode: "plan",
            createdAt: new Date(1).toISOString(),
          },
        ),
      ).rejects.toThrow("acknowledgement lost");

      // Only the exact parked id may be confirmed, so a stale caller cannot
      // settle a dispatch it never saw.
      expect(await first.confirmNativeAgentDispatch(input.key, "request-b")).toBe(false);
      expect(await first.confirmNativeAgentDispatch(input.key, "request-a")).toBe(true);

      const session = await first.getNativeAgentSession(input.key);
      expect(session?.pendingDispatch).toBeUndefined();
      // Recording the id is what stops a later retry from running it twice.
      expect(session?.dispatchedRequestIds).toEqual(["request-a"]);
      expect(session?.lastDispatchedTurn).toEqual({ requestId: "request-a", mode: "plan" });

      const replay = mock(async () => undefined);
      const outcome = await first.dispatchNativeAgentPromptOnce(input.key, "request-a", replay);
      expect(replay).not.toHaveBeenCalled();
      expect(outcome.dispatched).toBe(false);

      // Nothing left to confirm once it is settled.
      expect(await first.confirmNativeAgentDispatch(input.key, "request-a")).toBe(false);
    });
  });

  test("retires a parked dispatch the provider reports lost, keeping only a content-free marker", async () => {
    await withStorage(async (first) => {
      await first.getOrCreateNativeAgentSession(input, async () => "provider-session");
      const park = (requestId: string) =>
        expect(
          first.dispatchNativeAgentPromptOnce(
            input.key,
            requestId,
            async () => {
              throw new Error("acknowledgement lost");
            },
            { requestId, prompt: "secret prompt", createdAt: new Date(1).toISOString() },
          ),
        ).rejects.toThrow("acknowledgement lost");
      await park("request-a");

      // Only the exact parked id may be retired.
      expect(await first.retireNativeAgentDispatch(input.key, "request-b")).toBe(false);
      expect(await first.retireNativeAgentDispatch(input.key, "request-a")).toBe(true);
      let session = await first.getNativeAgentSession(input.key);
      expect(session?.pendingDispatch).toBeUndefined();
      // Nothing proves its turn ran, so it is never recorded as dispatched.
      expect(session?.dispatchedRequestIds ?? []).not.toContain("request-a");
      expect(Object.keys(session?.retiredDispatch ?? {}).sort()).toEqual([
        "requestId",
        "retiredAt",
      ]);
      expect(session?.retiredDispatch?.requestId).toBe("request-a");
      expect(JSON.stringify(session)).not.toContain("secret prompt");
      expect(await first.retireNativeAgentDispatch(input.key, "request-a")).toBe(false);

      // A later retirement replaces it.
      await park("request-c");
      expect(await first.retireNativeAgentDispatch(input.key, "request-c")).toBe(true);
      session = await first.getNativeAgentSession(input.key);
      expect(session?.retiredDispatch?.requestId).toBe("request-c");

      // A confirmed dispatch clears it.
      await first.dispatchNativeAgentPromptOnce(input.key, "request-d", async () => undefined);
      session = await first.getNativeAgentSession(input.key);
      expect(session?.retiredDispatch).toBeUndefined();
      expect(session?.dispatchedRequestIds).toContain("request-d");
    });
  });

  test("reads a session whose retired-dispatch marker is malformed", async () => {
    await withStorage(async (first) => {
      const session = await first.getOrCreateNativeAgentSession(
        input,
        async () => "provider-session",
      );
      const dataDir = first.getDataDir();
      const stored = readStoredValue<Record<string, unknown>>(dataDir, SESSIONS_STORE)!;
      stored[input.key] = { ...session, retiredDispatch: { requestId: 42 } };
      seedStore(dataDir, SESSIONS_STORE, stored);
      // The marker is validated where it is read, never with the record.
      expect((await first.getNativeAgentSession(input.key))?.providerSessionId).toBe(
        "provider-session",
      );
    });
  });

  test("leaves resolved and invalidated dispatch and steer content unrecoverable on disk", async () => {
    await withStorage(async (first) => {
      await first.getOrCreateNativeAgentSession(input, async () => "provider-session");
      const dataDir = first.getDataDir();
      // Each secret is persisted while its request is in flight; the check
      // inside the provider call proves the later absence is a real scrub.
      const persisted = (secret: string) => () => {
        expect(storageFilesContain(dataDir, secret)).toBe(true);
      };

      const acceptedSecret = "ACCEPTED-PROMPT-AND-ATTACHMENT-CONTENT";
      const acceptedInFlight = persisted(acceptedSecret);
      await first.dispatchNativeAgentPromptOnce(
        input.key,
        "accepted",
        async () => {
          acceptedInFlight();
        },
        {
          requestId: "accepted",
          prompt: acceptedSecret,
          attachments: [
            {
              type: "image",
              path: "/workspace/accepted.png",
              dataUrl: `data:image/png;base64,${acceptedSecret}`,
            },
          ],
          createdAt: new Date(1).toISOString(),
        },
      );
      expect(storageFilesContain(dataDir, acceptedSecret)).toBe(false);

      const clearedSecret = "CLEARED-PROMPT-CONTENT";
      await expect(
        first.dispatchNativeAgentPromptOnce(
          input.key,
          "cleared",
          async () => {
            persisted(clearedSecret)();
            throw new Error("ambiguous");
          },
          {
            requestId: "cleared",
            prompt: clearedSecret,
            createdAt: new Date(2).toISOString(),
          },
        ),
      ).rejects.toThrow("ambiguous");
      expect(await first.clearPendingNativeAgentDispatch(input.key, "cleared")).toBe(true);
      expect(storageFilesContain(dataDir, clearedSecret)).toBe(false);

      const appliedSteerSecret = "APPLIED-STEER-CONTENT";
      const appliedSteer = {
        requestId: "applied-steer",
        text: appliedSteerSecret,
        inputDigest: createHash("sha256").update(appliedSteerSecret).digest("hex"),
        expectedRunId: "turn-1",
        state: "prepared" as const,
        createdAt: new Date(3).toISOString(),
      };
      await first.dispatchNativeAgentSteerOnce(input.key, appliedSteer, async () => {
        persisted(appliedSteerSecret)();
        return { outcome: "applied" };
      });
      expect(storageFilesContain(dataDir, appliedSteerSecret)).toBe(false);

      const discardedSteerSecret = "DISCARDED-STEER-CONTENT";
      const discardedSteer = {
        ...appliedSteer,
        requestId: "discarded-steer",
        text: discardedSteerSecret,
        inputDigest: createHash("sha256").update(discardedSteerSecret).digest("hex"),
        createdAt: new Date(4).toISOString(),
      };
      await first.dispatchNativeAgentSteerOnce(input.key, discardedSteer, async () => ({
        outcome: "unknown",
        requestId: discardedSteer.requestId,
      }));
      expect(storageFilesContain(dataDir, discardedSteerSecret)).toBe(true);
      expect(await first.clearPendingNativeAgentSteer(input.key, discardedSteer.requestId)).toBe(
        true,
      );
      expect((await first.getNativeAgentSession(input.key))?.dispatchedRequestIds).not.toContain(
        discardedSteer.requestId,
      );
      expect(storageFilesContain(dataDir, discardedSteerSecret)).toBe(false);

      const invalidatedSecret = "INVALIDATED-PROMPT-CONTENT";
      await expect(
        first.dispatchNativeAgentPromptOnce(
          input.key,
          "invalidated",
          async () => {
            persisted(invalidatedSecret)();
            throw new Error("ambiguous");
          },
          {
            requestId: "invalidated",
            prompt: invalidatedSecret,
            createdAt: new Date(5).toISOString(),
          },
        ),
      ).rejects.toThrow("ambiguous");
      expect(await first.invalidateNativeAgentSession(input.key, "provider-session")).toBe(true);
      expect(storageFilesContain(dataDir, invalidatedSecret)).toBe(false);
      expect(JSON.stringify(readStoredValue(dataDir, SESSIONS_STORE))).not.toContain(input.key);
    });
  });

  test("bounds pending dispatches before provider I/O and round-trips accepted records", async () => {
    await withStorage(async (first) => {
      await first.getOrCreateNativeAgentSession(input, async () => "provider-session");
      const dispatch = mock(async () => undefined);
      await expect(
        first.dispatchNativeAgentPromptOnce(input.key, "oversized", dispatch, {
          requestId: "oversized",
          prompt: "x".repeat(32 * 1024 * 1024),
          createdAt: new Date(1).toISOString(),
        }),
      ).rejects.toThrow("exceeds the 32 MB limit");
      expect(dispatch).not.toHaveBeenCalled();
      expect((await first.getNativeAgentSession(input.key))?.pendingDispatch).toBeUndefined();

      const recoverable = {
        requestId: "recoverable",
        prompt: "round-trip prompt",
        schema: { type: "object" },
        attachments: [
          {
            type: "image" as const,
            path: "/workspace/round-trip.png",
            dataUrl: "data:image/png;base64,cG5n",
          },
        ],
        createdAt: new Date(2).toISOString(),
      };
      await expect(
        first.dispatchNativeAgentPromptOnce(
          input.key,
          recoverable.requestId,
          async () => {
            throw new Error("ambiguous");
          },
          recoverable,
        ),
      ).rejects.toThrow("ambiguous");
      const restarted = new StorageService(first.getDataDir());
      await restarted.init();
      expect((await restarted.getNativeAgentSession(input.key))?.pendingDispatch).toEqual(
        recoverable,
      );
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
        async () => ({ dispatched: false, incompleteTurnNotice: notice }),
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

  test("keeps recovery notices under their original persisted field name", async () => {
    await withStorage(async (first) => {
      await first.getOrCreateNativeAgentSession(input, async () => "provider-session");
      const notice = {
        kind: "failed" as const,
        assistantMessageId: "assistant-1",
        updatedAt: "2026-08-10T10:00:00.000Z",
      };
      expect(await first.setIncompleteTurnNotice(input.key, "provider-session", notice)).toBe(true);

      // Older versions wrote this exact field into native-agent-sessions.json,
      // and the legacy import carries their records over unchanged; a rename
      // would drop the notices those records hold.
      expect(
        readStoredValue<Record<string, unknown>>(first.getDataDir(), SESSIONS_STORE)?.[input.key],
      ).toMatchObject({ openCodeIncompleteTurnNotice: notice });
      const restarted = new StorageService(first.getDataDir());
      await restarted.init();
      const session = await restarted.getNativeAgentSession(input.key);
      expect(session?.openCodeIncompleteTurnNotice).toEqual(notice);
      expect(session && sessionIncompleteTurnNotice(session)).toEqual(notice);

      expect(await restarted.setIncompleteTurnNotice(input.key, "provider-session", null)).toBe(
        true,
      );
      expect(
        (await restarted.getNativeAgentSession(input.key))?.openCodeIncompleteTurnNotice,
      ).toBeUndefined();
    });
  });

  test("reads a recovery notice an older build wrote into the legacy session file", async () => {
    const notice = {
      kind: "exhausted" as const,
      assistantMessageId: "assistant-legacy",
      updatedAt: "2026-08-10T10:00:00.000Z",
    };
    const legacy = {
      [input.key]: {
        ...input,
        providerSessionId: "legacy-provider-session",
        openCodeIncompleteTurnNotice: notice,
        createdAt: new Date(1).toISOString(),
        updatedAt: new Date(2).toISOString(),
      },
    };
    await withLegacySessions(legacy, async (first) => {
      const session = await first.getNativeAgentSession(input.key);
      expect(session && sessionIncompleteTurnNotice(session)).toEqual(notice);
    });
  });

  test("conditionally invalidates only the provider session that was checked", async () => {
    await withStorage(async (first) => {
      await first.getOrCreateNativeAgentSession(input, async () => "provider-session");
      expect(await first.invalidateNativeAgentSession(input.key, "another-session")).toBe(false);
      expect(await first.getNativeAgentSession(input.key)).not.toBeNull();
      expect(await first.invalidateNativeAgentSession(input.key, "provider-session")).toBe(true);
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
      expect(
        (
          await first.adoptNativeAgentSession({
            ...input,
            providerSessionId: "provider-old",
          })
        ).providerSessionId,
      ).toBe(adopted.providerSessionId);
      await first.dispatchNativeAgentPromptOnce(input.key, "request-old", async () => undefined);
      await expect(
        first.adoptNativeAgentSession({
          ...input,
          providerSessionId: "provider-new",
        }),
      ).rejects.toThrow("provider collision");
      await expect(
        first.adoptNativeAgentSession({
          ...input,
          providerSessionId: "provider-new",
          expectedProviderSessionId: "wrong-old",
        }),
      ).rejects.toThrow("provider collision");

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

  test("records controls when a resume lands back on the current provider session", async () => {
    await withStorage(async (first) => {
      const adopted = await first.adoptNativeAgentSession({
        ...input,
        providerSessionId: "provider-same",
        controls: { modelId: "old-model", mode: "build", fastMode: false },
      });
      await first.dispatchNativeAgentPromptOnce(input.key, "request-kept", async () => undefined);

      // Resuming in place: the provider already received these controls, so
      // storage must not keep reporting the old ones after a restart.
      const resumed = await first.adoptNativeAgentSession({
        ...input,
        providerSessionId: "provider-same",
        controls: { modelId: "new-model", reasoningId: "high", fastMode: true },
      });
      expect(resumed.providerSessionId).toBe("provider-same");
      expect(resumed.controls).toEqual({
        modelId: "new-model",
        mode: "build",
        reasoningId: "high",
        fastMode: true,
      });
      // Adopting the same session is not a replacement, so dispatch history
      // and creation time survive.
      expect(resumed.dispatchedRequestIds).toEqual(["request-kept"]);
      expect(resumed.createdAt).toBe(adopted.createdAt);
      expect((await first.getNativeAgentSession(input.key))?.controls).toEqual(resumed.controls);

      // An adopt that changes nothing must not rewrite the record.
      const unchanged = await first.adoptNativeAgentSession({
        ...input,
        providerSessionId: "provider-same",
        controls: { modelId: "new-model" },
      });
      expect(unchanged.updatedAt).toBe(resumed.updatedAt);

      // No controls at all still means "leave them alone".
      const untouched = await first.adoptNativeAgentSession({
        ...input,
        providerSessionId: "provider-same",
      });
      expect(untouched.controls).toEqual(resumed.controls);
    });
  });

  test("initializes an inferred composer selection only when no model is stored", async () => {
    await withStorage(async (first) => {
      await first.getOrCreateNativeAgentSession(input, async () => "provider-session");
      const inferred = await first.initializeNativeAgentSessionInferredComposerIfAbsent(
        input.key,
        "provider-session",
        { modelId: "opencode-go/deepseek-v4-flash", reasoningId: "default" },
      );
      expect(inferred.inferredComposerSelection).toEqual({
        modelId: "opencode-go/deepseek-v4-flash",
        reasoningId: "default",
      });
      expect(inferred.controls?.modelId).toBeUndefined();

      const unchanged = await first.initializeNativeAgentSessionInferredComposerIfAbsent(
        input.key,
        "provider-session",
        { modelId: "opencode/nemotron-ultra-free" },
      );
      expect(unchanged.inferredComposerSelection).toEqual(inferred.inferredComposerSelection);
      expect(unchanged.updatedAt).toBe(inferred.updatedAt);

      const chosen = await first.updateNativeAgentSessionControls(input.key, "provider-session", {
        modelId: "opencode-go/deepseek-v4-pro",
      });
      expect(chosen.controls?.modelId).toBe("opencode-go/deepseek-v4-pro");
      expect(chosen.inferredComposerSelection).toBeUndefined();

      const ignored = await first.initializeNativeAgentSessionInferredComposerIfAbsent(
        input.key,
        "provider-session",
        { modelId: "opencode/nemotron-ultra-free" },
      );
      expect(ignored.controls?.modelId).toBe("opencode-go/deepseek-v4-pro");
      expect(ignored.inferredComposerSelection).toBeUndefined();
    });
  });

  test("drops a stored pre-approval-mode permissionMode value on any control update", async () => {
    await withStorage(async (first) => {
      await first.adoptNativeAgentSession({
        ...input,
        agent: "claude",
        providerSessionId: "provider-session",
        controls: {
          modelId: "claude-model",
          parameterValues: { permissionMode: "acceptEdits", thinking: "adaptive" },
        },
      });
      const updated = await first.updateNativeAgentSessionControls(input.key, "provider-session", {
        approvalMode: "default",
      });
      expect(updated.controls?.parameterValues).toEqual({ thinking: "adaptive" });
      expect(updated.controls?.approvalMode).toBe("default");
    });
  });

  // Codex's catalogue once offered a reasoning `summary` the bridge never
  // applied. The retirement is keyed by platform: another platform's model can
  // still offer a live parameter with the same id.
  test.each([
    ["codex", { audit: true }],
    ["cursor", { summary: "auto", audit: true }],
  ] as const)(
    "drops a stored retired summary value for %s only on a control update",
    async (agent, expected) => {
      await withStorage(async (first) => {
        await first.adoptNativeAgentSession({
          ...input,
          agent,
          providerSessionId: "provider-session",
          controls: { modelId: "model-1", parameterValues: { summary: "auto", audit: true } },
        });
        const updated = await first.updateNativeAgentSessionControls(
          input.key,
          "provider-session",
          { fastMode: true },
        );
        expect(updated.controls?.parameterValues).toEqual(expected);
        expect(updated.controls?.fastMode).toBe(true);
      });
    },
  );

  test("rejects a replacement expectation when no mapping exists", async () => {
    await withStorage(async (first) => {
      await expect(
        first.adoptNativeAgentSession({
          ...input,
          providerSessionId: "provider-new",
          expectedProviderSessionId: "provider-old",
        }),
      ).rejects.toThrow("replacement target");
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
        await expect(
          first.adoptNativeAgentSession({
            ...collision,
            providerSessionId: "provider-other",
          }),
        ).rejects.toThrow("Native agent session key collision");
      }
      expect(createProviderSession).not.toHaveBeenCalled();
      expect((await first.getNativeAgentSession(input.key))?.providerSessionId).toBe(
        "provider-session",
      );
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
      await expect(
        first.getOrCreateNativeAgentSession({ ...input, key: " " }, create),
      ).rejects.toThrow("Native agent session input is invalid");
      await expect(
        first.getOrCreateNativeAgentSession({ ...input, environmentId: "" }, create),
      ).rejects.toThrow("Native agent session input is invalid");
      await expect(
        first.getOrCreateNativeAgentSession({ ...input, logicalSessionKey: "" }, create),
      ).rejects.toThrow("Native agent session input is invalid");
      await expect(
        first.getOrCreateNativeAgentSession(
          { ...input, agent: "gemini" as unknown as typeof input.agent },
          create,
        ),
      ).rejects.toThrow("Native agent session input is invalid");

      await expect(
        first.adoptNativeAgentSession({
          ...input,
          providerSessionId: " ",
        }),
      ).rejects.toThrow("Native agent session adoption input is invalid");
      await expect(
        first.adoptNativeAgentSession({
          ...input,
          providerSessionId: "provider-session",
          expectedProviderSessionId: " ",
        }),
      ).rejects.toThrow("Native agent session adoption input is invalid");

      await expect(first.invalidateNativeAgentSession("", "provider-session")).rejects.toThrow(
        "identity must not be blank",
      );
      await expect(first.invalidateNativeAgentSession(input.key, "")).rejects.toThrow(
        "identity must not be blank",
      );
      await expect(
        first.dispatchNativeAgentPromptOnce("", "request-1", async () => undefined),
      ).rejects.toThrow("dispatch key must not be blank");
      await expect(
        first.dispatchNativeAgentPromptOnce(input.key, " ", async () => undefined),
      ).rejects.toThrow("dispatch key must not be blank");
    });
  });

  test("bounds the dispatched request id history at one thousand entries", async () => {
    await withStorage(async (first) => {
      await first.getOrCreateNativeAgentSession(input, async () => "provider-session");
      // Seeding the store is the only way to reach the bound without a thousand
      // real cross-process writes; the persisted validator caps it at 1000 too.
      const dataDir = first.getDataDir();
      const stored = readStoredValue<Record<string, { dispatchedRequestIds?: string[] }>>(
        dataDir,
        SESSIONS_STORE,
      )!;
      stored[input.key]!.dispatchedRequestIds = Array.from(
        { length: 1_000 },
        (_, index) => `request-${index}`,
      );
      seedStore(dataDir, SESSIONS_STORE, stored);

      const { session } = await first.dispatchNativeAgentPromptOnce(
        input.key,
        "request-new",
        async () => undefined,
      );
      expect(session.dispatchedRequestIds).toHaveLength(1_000);
      expect(session.dispatchedRequestIds?.[0]).toBe("request-1");
      expect(session.dispatchedRequestIds?.at(-1)).toBe("request-new");
      // The oldest id was evicted, so replaying it is no longer suppressed.
      expect(
        (await first.dispatchNativeAgentPromptOnce(input.key, "request-0", async () => undefined))
          .dispatched,
      ).toBe(true);
      expect(
        (await first.dispatchNativeAgentPromptOnce(input.key, "request-new", async () => undefined))
          .dispatched,
      ).toBe(false);
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
      expect((await first.getNativeAgentSession(other.key))?.providerSessionId).toBe("provider-2");
    });
  });

  test("a retried environment delete clears display tails its sessions no longer point to", async () => {
    await withStorage(async (first) => {
      const tail = createNativeAgentDisplayTail({
        environmentId: "env-1",
        agent: "opencode",
        logicalSessionKey: input.logicalSessionKey,
        providerSessionId: "provider-1",
        historyEpoch: "epoch-1",
        messages: [],
        updatedAt: new Date(0).toISOString(),
      })!;
      // What an earlier, partly failed delete leaves: no session, a tail.
      expect(await first.putNativeAgentDisplayTail(input.key, tail)).toBe(true);

      await first.deleteNativeAgentSessionsByEnvironment("env-1");

      expect(await first.getNativeAgentDisplayTail(input.key)).toBeNull();
    });
  });

  test("leaves a deleted environment's sessions unrecoverable on disk", async () => {
    await withStorage(async (first) => {
      await first.addEnvironment({
        ...(await first.getEnvironment("env-1"))!,
        id: "env-2",
      });
      await first.getOrCreateNativeAgentSession(
        { ...input, environmentId: "env-2", key: "keep-key", logicalSessionKey: "KEEP-ME" },
        async () => "provider-keep",
      );
      // A deleted row survives in free pages and WAL frames unless the delete
      // scrubs them, so the deleted environment's logical key and provider
      // session id must not be readable anywhere in the database files.
      await first.getOrCreateNativeAgentSession(
        { ...input, logicalSessionKey: "DROP-ME" },
        async () => "provider-drop",
      );
      const dataDir = first.getDataDir();
      expect(storageFilesContain(dataDir, "DROP-ME")).toBe(true);
      expect(storageFilesContain(dataDir, "provider-drop")).toBe(true);

      await first.deleteNativeAgentSessionsByEnvironment("env-1");

      expect(JSON.stringify(readStoredValue(dataDir, SESSIONS_STORE))).toContain("KEEP-ME");
      expect(storageFilesContain(dataDir, "DROP-ME")).toBe(false);
      expect(storageFilesContain(dataDir, "provider-drop")).toBe(false);
    });
  });

  test("leaves superseded unrecognized session records unrecoverable after a delete", async () => {
    await withStorage(async (first) => {
      const dataDir = first.getDataDir();
      // An unknown-version record for env-1, since overwritten by another
      // process: its old row content can linger in the database files the way
      // it used to linger in a retained backup.
      seedStore(dataDir, SESSIONS_STORE, {
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
      });
      seedStore(dataDir, SESSIONS_STORE, {});
      await first.getOrCreateNativeAgentSession(input, async () => "provider-current");
      expect(storageFilesContain(dataDir, "DROP-FUTURE-METADATA")).toBe(true);

      await first.deleteNativeAgentSessionsByEnvironment("env-1");
      expect(storageFilesContain(dataDir, "DROP-FUTURE-METADATA")).toBe(false);
      expect(storageFilesContain(dataDir, "provider-future")).toBe(false);
      expect(readStoredValue(dataDir, SESSIONS_STORE)).toEqual({});
    });
  });

  test("treats a blank or unknown environment as nothing to delete", async () => {
    await withStorage(async (first) => {
      await first.getOrCreateNativeAgentSession(input, async () => "provider-session");
      await first.deleteNativeAgentSessionsByEnvironment("");
      await first.deleteNativeAgentSessionsByEnvironment("env-never-existed");
      expect((await first.getNativeAgentSession(input.key))?.providerSessionId).toBe(
        "provider-session",
      );
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
        (
          await first.acknowledgeStartupAgentSession(
            "env-1",
            "provider-old",
            "2026-07-29T11:00:00.000Z",
          )
        ).startupAgentSession,
      ).toBeDefined();
      expect(
        (
          await first.acknowledgeStartupAgentSession(
            "env-1",
            "provider-new",
            "2026-07-29T12:00:00.000Z",
          )
        ).startupAgentSession,
      ).toBeUndefined();
    });
  });
});

describe("StorageService native agent session leases are per key", () => {
  const otherInput = { ...input, key: "other-session-key", logicalSessionKey: "env-env-1:other" };

  function gate(): { opened: Promise<void>; open: () => void } {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { opened, open };
  }

  test("a provider dispatch held on one key does not block another key, in or across processes", async () => {
    await withStorage(async (first, second) => {
      await first.getOrCreateNativeAgentSession(input, async () => "provider-a");
      await first.getOrCreateNativeAgentSession(otherInput, async () => "provider-b");
      const providerAck = gate();
      const entered = gate();
      const slow = first.dispatchNativeAgentPromptOnce(input.key, "request-a", async () => {
        entered.open();
        await providerAck.opened;
      });
      await entered.opened;
      // Both complete while key A's lease is still held across its provider call.
      await expect(
        first.dispatchNativeAgentPromptOnce(otherInput.key, "request-b", async () => undefined),
      ).resolves.toMatchObject({ dispatched: true });
      await expect(
        second.dispatchNativeAgentPromptOnce(otherInput.key, "request-c", async () => undefined),
      ).resolves.toMatchObject({ dispatched: true });
      providerAck.open();
      await expect(slow).resolves.toMatchObject({ dispatched: true });
      expect((await second.getNativeAgentSession(input.key))?.dispatchedRequestIds).toEqual([
        "request-a",
      ]);
      expect((await first.getNativeAgentSession(otherInput.key))?.dispatchedRequestIds).toEqual([
        "request-b",
        "request-c",
      ]);
    });
  });

  test("concurrent writers of different keys keep each other's rows and unreadable records", async () => {
    await withStorage(async (first, second) => {
      const dataDir = first.getDataDir();
      await first.getOrCreateNativeAgentSession(input, async () => "provider-a");
      const stored = readStoredValue<Record<string, unknown>>(dataDir, SESSIONS_STORE)!;
      const opaque = { version: 99, key: "future", note: "written by a newer build" };
      seedStore(dataDir, SESSIONS_STORE, { ...stored, future: opaque });
      // Each instance cached the store before the other's commit.
      await Promise.all([first.listNativeAgentSessions(), second.listNativeAgentSessions()]);
      await Promise.all([
        first.updateNativeAgentSessionControls(input.key, "provider-a", { modelId: "model-a" }),
        second.getOrCreateNativeAgentSession(otherInput, async () => "provider-b"),
      ]);
      const after = readStoredValue<Record<string, Record<string, unknown>>>(
        dataDir,
        SESSIONS_STORE,
      )!;
      expect(after[input.key]).toMatchObject({ controls: { modelId: "model-a" } });
      expect(after[otherInput.key]).toMatchObject({ providerSessionId: "provider-b" });
      expect(after.future).toEqual(opaque);
    });
  });

  test("a create that overlaps environment deletion leaves no session behind", async () => {
    await withStorage(async (first, second) => {
      const created = gate();
      const entered = gate();
      const create = first
        .getOrCreateNativeAgentSession(input, async () => {
          entered.open();
          await created.opened;
          return "provider-late";
        })
        .then(
          () => "created",
          (error: unknown) => (error as Error).message,
        );
      await entered.opened;
      await second.updateEnvironment("env-1", { deletionRequestedAt: new Date().toISOString() });
      // The sweep cannot see a key that is not committed yet; the create's own
      // commit refuses it instead.
      await second.deleteNativeAgentSessionsByEnvironment("env-1");
      created.open();
      expect(await create).toContain("being deleted");
      expect(await first.listNativeAgentSessions()).toEqual([]);
    });
  });

  test("environment deletion waits for an in-flight dispatch on each key, one key at a time", async () => {
    await withStorage(async (first, second) => {
      await first.getOrCreateNativeAgentSession(input, async () => "provider-a");
      await first.getOrCreateNativeAgentSession(otherInput, async () => "provider-b");
      const providerAck = gate();
      const entered = gate();
      const dispatch = first.dispatchNativeAgentPromptOnce(input.key, "request-a", async () => {
        entered.open();
        await providerAck.opened;
      });
      await entered.opened;
      await second.updateEnvironment("env-1", { deletionRequestedAt: new Date().toISOString() });
      let deleted = false;
      const deletion = second.deleteNativeAgentSessionsByEnvironment("env-1").then(() => {
        deleted = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(deleted).toBe(false);
      providerAck.open();
      await Promise.all([dispatch, deletion]);
      expect(await second.listNativeAgentSessions()).toEqual([]);
    });
  });
});
