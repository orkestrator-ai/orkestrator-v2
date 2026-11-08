import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newSessionState } from "./agent-session.js";
import {
  drainPersistence,
  encodeStateWithinBudget,
  loadPersistedState,
  PersistenceClosedError,
  persistBarrier,
  reopenPersistenceForTests,
  schedulePersist,
  setPersistWriteGateForTests,
  settlePersistenceForTests,
  type PersistWriteForTests,
} from "./persistence.js";
import {
  buildCommandCatalogue,
  publishCommandCatalogue,
  resolveCommandSelection,
} from "./commands.js";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import {
  captureHistoryEntries,
  rememberHistoryMessage,
  resolveHistoryTarget,
} from "./history-target.js";
import { MAX_STATE_FILE_BYTES } from "./config.js";
import { clientSessionKeys, sessions, type PersistedState } from "./state.js";
import { testApprovalDeadline } from "./testing/approval-fixtures.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pi-bridge-persistence-"));
  process.env.PI_BRIDGE_STATE_DIR = directory;
  sessions.clear();
  clientSessionKeys.clear();
  // A drain closes persistence for the rest of the process; each test here
  // starts with it open.
  reopenPersistenceForTests();
});

afterEach(async () => {
  setPersistWriteGateForTests();
  await settlePersistenceForTests();
  delete process.env.PI_BRIDGE_STATE_DIR;
  sessions.clear();
  clientSessionKeys.clear();
  await rm(directory, { recursive: true, force: true });
});

async function writeState(state: unknown): Promise<void> {
  await writeFile(join(directory, "state.json"), JSON.stringify(state), "utf8");
}

async function readState(): Promise<PersistedState> {
  return JSON.parse(await readFile(join(directory, "state.json"), "utf8")) as PersistedState;
}

test("intermediate response mappings survive detach and bridge persistence restore", async () => {
  const manager = SessionManager.create("/workspace", directory);
  manager.appendMessage({ role: "user", content: "first", timestamp: 0 });
  const response = (text: string) => ({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "test",
    model: "model",
    stopReason: "stop",
    timestamp: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  const state = newSessionState();
  const intermediate = response("intermediate");
  rememberHistoryMessage(state, "live-intermediate", intermediate);
  const id = manager.appendMessage(intermediate as never);
  manager.appendMessage(response("final") as never);
  captureHistoryEntries(state, manager);
  state.sessionFile = manager.getSessionFile();
  state.messages = [
    {
      id: "live-intermediate",
      role: "assistant",
      content: "intermediate",
      parts: [],
      createdAt: new Date().toISOString(),
    },
  ];
  sessions.set(state.id, state);
  await persistBarrier();
  sessions.clear();
  await loadPersistedState();
  const restored = sessions.get(state.id)!;
  const reopened = {
    sessionManager: SessionManager.open(state.sessionFile!, directory, "/workspace"),
  } as unknown as AgentSession;
  expect(restored.historyMessages).toBeUndefined();
  expect(resolveHistoryTarget(restored, reopened, "live-intermediate")).toEqual({
    entryId: id,
    position: "at",
  });
});

test("malformed and oversized restored history maps are bounded", async () => {
  await writeState({
    version: 1,
    provider: "pi",
    sessions: [
      {
        id: "bounded",
        messages: [],
        historyEntries: [
          ...Array.from({ length: 1100 }, (_, i) => [`row-${i}`, `entry-${i}`]),
          ["bad", 7],
          ["", "entry"],
          ["x".repeat(257), "entry"],
        ],
      },
    ],
  });
  await loadPersistedState();
  const entries = sessions.get("bounded")!.historyEntries!;
  expect(entries.size).toBeLessThanOrEqual(1024);
  expect(entries.has("row-0")).toBe(false);
  expect(entries.has("bad")).toBe(false);
  expect(entries.get("row-1099")).toBe("entry-1099");
});

describe("the whole-file bound", () => {
  /** A session whose transcript alone is a meaningful share of the cap. */
  function bulkySession(key: string, lastAccessed: number) {
    const state = newSessionState(key);
    state.lastAccessed = lastAccessed;
    state.sessionFile = `/sessions/${key}.jsonl`;
    state.promptJournal.set("req-1", {
      requestId: "req-1",
      state: "completed",
      acceptedAt: 1,
    });
    state.messages = [
      {
        id: `${key}-m1`,
        role: "assistant",
        content: "x".repeat(9 * 1024 * 1024),
        parts: [],
        createdAt: "2026-01-01T00:00:00Z",
      },
    ];
    return state;
  }

  test("sheds transcripts oldest-first rather than skipping the write", async () => {
    // Transcripts are trimmed per session and never in aggregate, so enough
    // sessions always eventually exceed the whole-file bound. Skipping the
    // write there is permanent: nothing shrinks the aggregate afterwards.
    // Four at ~9MB each is over the 32MB cap; three is under it, so exactly
    // one transcript has to go.
    for (const [index, key] of ["old", "middle", "new", "newest"].entries()) {
      const state = bulkySession(key, index + 1);
      sessions.set(state.id, state);
    }

    schedulePersist();
    await drainPersistence();

    const written = await readState();
    expect(written.sessions).toHaveLength(4);
    // What makes a session recoverable is its id, its Pi session file and its
    // journal — all tiny. Only the rendered transcript is shed, and the
    // least-recently-touched session loses it first.
    const byKey = new Map(written.sessions.map((entry) => [entry.clientSessionKey, entry]));
    expect(byKey.get("old")!.messages).toHaveLength(0);
    expect(byKey.get("old")!.transcriptTruncated).toBe(true);
    expect(byKey.get("old")!.sessionFile).toBe("/sessions/old.jsonl");
    expect(byKey.get("old")!.promptJournal).toHaveLength(1);
    // Shedding stops as soon as it fits, so nothing newer is touched.
    expect(byKey.get("middle")!.messages).toHaveLength(1);
    expect(byKey.get("newest")!.messages).toHaveLength(1);
  });

  test("leaves live state untouched when it sheds", async () => {
    const state = bulkySession("old", 1);
    sessions.set(state.id, state);
    for (const [index, key] of ["middle", "new", "newest"].entries()) {
      const other = bulkySession(key, index + 2);
      sessions.set(other.id, other);
    }

    schedulePersist();
    await drainPersistence();

    // The tab the user is looking at keeps its transcript; only the persisted
    // copy is degraded.
    expect(state.messages).toHaveLength(1);
    expect(state.transcriptTruncated).toBe(false);
  });

  test("shedding encodes each record once, not the whole payload per session", async () => {
    // Forty 1 MB transcripts, so several have to go before the 32 MB cap is met.
    for (let index = 0; index < 40; index += 1) {
      const state = newSessionState(`session-${index}`);
      state.lastAccessed = index + 1;
      state.messages.push({
        id: `message-${index}`,
        role: "assistant",
        content: "x".repeat(1024 * 1024),
        parts: [],
        createdAt: "2026-11-04T00:00:00.000Z",
      });
      sessions.set(state.id, state);
    }
    const stringify = spyOn(JSON, "stringify");
    try {
      // One publication: the drain's final write. (A scheduled write as well
      // would be a second, legitimate encoding of the same payload.)
      await drainPersistence();
      const encoded = stringify.mock.results.reduce(
        (sum, result) => sum + ((result.value as string | undefined)?.length ?? 0),
        0,
      );
      // Twice the file would already be one whole re-encoding too many.
      expect(encoded).toBeLessThan(2 * 40 * 1024 * 1024);
    } finally {
      stringify.mockRestore();
    }

    const written = await readState();
    expect(written.sessions).toHaveLength(40);
    const kept = written.sessions.filter((entry) => entry.messages.length > 0);
    // Oldest-touched first, and it stops as soon as the file fits.
    expect(kept.map((entry) => entry.clientSessionKey)).toEqual(
      Array.from({ length: kept.length }, (_, index) => `session-${40 - kept.length + index}`),
    );
    expect(kept.length).toBe(31);
  });

  test("refuses to load a file past the bound rather than parsing it", async () => {
    await writeFile(
      join(directory, "state.json"),
      JSON.stringify({
        version: 1,
        provider: "pi",
        sessions: [{ id: "a", messages: [], revision: 0, structured: [], promptJournal: [] }],
        padding: "x".repeat(33 * 1024 * 1024),
      }),
      "utf8",
    );

    await loadPersistedState();
    expect(sessions.size).toBe(0);
  });
});

describe("encoding the state file", () => {
  /** The encoding this replaced, kept verbatim as the bytes it must still produce. */
  function encodeAsBefore(
    payload: PersistedState,
    order: Map<string, number>,
    budget: number,
  ): string | undefined {
    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized) <= budget) return serialized;
    const byOldest = [...payload.sessions].sort(
      (left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0),
    );
    for (const session of byOldest) {
      if (session.messages.length === 0) continue;
      session.droppedMessages = (session.droppedMessages ?? 0) + session.messages.length;
      session.messages = [];
      session.transcriptTruncated = true;
      if (Buffer.byteLength(JSON.stringify(payload)) <= budget) return JSON.stringify(payload);
    }
    return undefined;
  }

  function randomState(random: () => number): PersistedState {
    const count = Math.floor(random() * 6);
    return {
      version: 1,
      provider: "pi",
      sessions: Array.from({ length: count }, (_, index) => ({
        id: `session-${index}`,
        status: "idle",
        messages: Array.from({ length: Math.floor(random() * 3) }, (_, row) => ({
          id: `row-${row}`,
          role: "assistant",
          // Multibyte and escaped text, so characters and bytes disagree.
          content: `é"🙂\n`.repeat(Math.floor(random() * 40)),
          parts: [],
          createdAt: "2026-11-04T00:00:00.000Z",
        })),
        droppedMessages: Math.floor(random() * 3),
        droppedParts: 0,
        transcriptTruncated: false,
        revision: index,
        structured: [],
        promptJournal: [],
        steerJournal: [],
        composer: {},
      })) as unknown as PersistedState["sessions"],
    };
  }

  test("writes the old bytes for any state and budget", () => {
    let seed = 11;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let round = 0; round < 300; round += 1) {
      const state = randomState(random);
      const order = new Map(
        state.sessions.map((session) => [session.id, Math.floor(random() * 4)]),
      );
      const budget = 50 + Math.floor(random() * 1_500);
      const expected = encodeAsBefore(structuredClone(state), order, budget);
      expect(encodeStateWithinBudget(structuredClone(state), order, budget)).toBe(expected);
    }
  });

  test("an empty state is the empty envelope", () => {
    const payload: PersistedState = { version: 1, provider: "pi", sessions: [] };
    expect(encodeStateWithinBudget(payload, new Map(), 1_000)).toBe(JSON.stringify(payload));
  });

  test("answers nothing when the non-transcript state alone does not fit", () => {
    const state = randomState(() => 0.9);
    expect(encodeStateWithinBudget(state, new Map(), 10)).toBeUndefined();
  });
});

describe("a durability barrier", () => {
  test("rejects when the non-transcript state cannot fit, and publishes nothing", async () => {
    // Dispatch waits on this barrier, so swallowing the failure would let a
    // prompt reach Pi with no journal entry on disk, and a restart could then
    // send the same request id again.
    const small = newSessionState("small");
    small.sessionFile = "/sessions/small.jsonl";
    sessions.set(small.id, small);
    await persistBarrier();
    const published = await readFile(join(directory, "state.json"), "utf8");

    // A session's error is kept whole, and shedding only ever touches transcripts.
    const oversized = newSessionState("oversized");
    oversized.error = "x".repeat(MAX_STATE_FILE_BYTES + 1);
    sessions.set(oversized.id, oversized);

    await expect(persistBarrier()).rejects.toThrow(
      "Pi bridge state exceeds its persistence budget",
    );
    expect(await readFile(join(directory, "state.json"), "utf8")).toBe(published);

    // The failure does not poison the queue: once it fits, barriers publish again.
    sessions.delete(oversized.id);
    await persistBarrier();
    expect((await readState()).sessions.map((entry) => entry.clientSessionKey)).toEqual(["small"]);
  });
});

describe("a durability barrier during shutdown", () => {
  /** A write gate that holds each publication until the test releases it. */
  function holdWrites() {
    const held: Array<{ write: PersistWriteForTests; release: () => void }> = [];
    const arrivals: Array<() => void> = [];
    setPersistWriteGateForTests(
      (write) =>
        new Promise<void>((release) => {
          held.push({ write, release });
          arrivals.shift()?.();
        }),
    );
    return {
      held,
      /** Resolves once `count` publications have reached the gate. */
      arrived(count: number): Promise<void> {
        if (held.length >= count) return Promise.resolve();
        return new Promise<void>((resolve) => {
          const check = () => (held.length >= count ? resolve() : arrivals.push(check));
          arrivals.push(check);
        });
      },
    };
  }

  test("a barrier issued while the drain's final write runs rejects and never writes", async () => {
    const state = newSessionState("draining");
    state.sessionFile = "/sessions/draining.jsonl";
    sessions.set(state.id, state);
    const gate = holdWrites();

    const drain = drainPersistence();
    await gate.arrived(1);
    expect(gate.held.map(({ write }) => write.barrier)).toEqual([false]);

    // Routes are still served until `server.close`, so a request can reach a
    // barrier now. Chaining it would run a second writer on the same `.tmp`
    // file beside the final write; resolving it would let dispatch proceed on
    // a durability the closing bridge will not provide.
    await expect(persistBarrier()).rejects.toBeInstanceOf(PersistenceClosedError);
    expect(gate.held).toHaveLength(1);

    gate.held[0]!.release();
    await drain;
    // Exactly one publication: the drain's final write. Nothing queued behind it.
    expect(gate.held).toHaveLength(1);
    expect((await readState()).sessions.map((entry) => entry.clientSessionKey)).toEqual([
      "draining",
    ]);
    await expect(persistBarrier()).rejects.toBeInstanceOf(PersistenceClosedError);
  });

  test("a barrier queued before shutdown began rejects instead of writing behind the drain", async () => {
    sessions.set("queued", newSessionState("queued"));
    const gate = holdWrites();

    // A best-effort write is running when a barrier queues behind it.
    schedulePersist();
    await gate.arrived(1);
    const barrier = persistBarrier();
    const drain = drainPersistence();
    // A second drain shares the first: one final write, not two.
    const again = drainPersistence();

    gate.held[0]!.release();
    await expect(barrier).rejects.toBeInstanceOf(PersistenceClosedError);
    await gate.arrived(2);
    expect(gate.held.map(({ write }) => write.barrier)).toEqual([false, false]);
    gate.held[1]!.release();
    await Promise.all([drain, again]);
    expect(gate.held).toHaveLength(2);
  });
});

describe("writing", () => {
  test("records an unfinished turn as idle and its request id as ambiguous", async () => {
    const state = newSessionState("tab-1");
    state.status = "running";
    state.sessionFile = "/sessions/one.jsonl";
    state.promptJournal.set("req-1", {
      requestId: "req-1",
      state: "accepted",
      acceptedAt: 1,
    });
    state.promptJournal.set("req-2", {
      requestId: "req-2",
      state: "completed",
      acceptedAt: 2,
    });
    sessions.set(state.id, state);

    schedulePersist();
    await drainPersistence();

    const persisted = await readState();
    const session = persisted.sessions[0]!;
    // Recording `running` would have the next start report a turn nothing is
    // executing; recording the id as anything but ambiguous would let the same
    // prompt be dispatched twice.
    expect(session.status).toBe("idle");
    expect(session.sessionFile).toBe("/sessions/one.jsonl");
    expect(session.promptJournal).toEqual([
      { requestId: "req-1", state: "ambiguous", acceptedAt: 1 },
      { requestId: "req-2", state: "completed", acceptedAt: 2 },
    ]);
  });

  test("keeps the lost-write advisory's once-per-session mark across a restart", async () => {
    const state = newSessionState("tab-lost-write");
    state.lostWriteNoticed = true;
    sessions.set(state.id, state);
    schedulePersist();
    await drainPersistence();
    expect((await readState()).sessions[0]).toMatchObject({ lostWriteNoticed: true });

    sessions.clear();
    clientSessionKeys.clear();
    await loadPersistedState();
    expect(sessions.get(state.id)?.lostWriteNoticed).toBe(true);
  });

  test("never persists a parked approval", async () => {
    const state = newSessionState();
    state.approvals.set("a1", {
      id: "a1",
      toolCallId: "call-1",
      toolName: "bash",
      input: {},
      createdAt: 1,
      deadline: testApprovalDeadline(1),
      settle: () => undefined,
    });
    sessions.set(state.id, state);

    schedulePersist();
    await drainPersistence();

    // An approval is a promise held by a process that no longer exists. There
    // is nothing a successor could do with it but deny it, so it is not stored.
    expect(JSON.stringify(await readState())).not.toContain("call-1");
  });

  test("keeps delivered steer evidence and makes an in-flight queue ambiguous", async () => {
    const state = newSessionState();
    state.steerJournal.set("queued", {
      requestId: "queued",
      inputDigest: "digest-1",
      expectedRunId: "pi:generation:1",
      state: "queued",
      createdAt: 1,
    });
    state.steerJournal.set("delivered", {
      requestId: "delivered",
      inputDigest: "digest-2",
      expectedRunId: "pi:generation:1",
      state: "delivered",
      createdAt: 2,
    });
    state.steerJournal.set("dropped", {
      requestId: "dropped",
      inputDigest: "digest-3",
      expectedRunId: "pi:generation:1",
      state: "dropped",
      createdAt: 3,
    });
    sessions.set(state.id, state);

    schedulePersist();
    await drainPersistence();

    expect((await readState()).sessions[0]?.steerJournal).toEqual([
      {
        requestId: "queued",
        inputDigest: "digest-1",
        expectedRunId: "pi:generation:1",
        state: "ambiguous",
        createdAt: 1,
      },
      {
        requestId: "delivered",
        inputDigest: "digest-2",
        expectedRunId: "pi:generation:1",
        state: "delivered",
        createdAt: 2,
      },
      {
        requestId: "dropped",
        inputDigest: "digest-3",
        expectedRunId: "pi:generation:1",
        state: "dropped",
        createdAt: 3,
      },
    ]);
  });
});

describe("loading", () => {
  test("restores the transcript, the selection and the session-file pointer", async () => {
    await writeState({
      version: 1,
      provider: "pi",
      sessions: [
        {
          id: "session-1",
          clientSessionKey: "tab-1",
          sessionFile: "/sessions/one.jsonl",
          status: "idle",
          revision: 7,
          messages: [
            { id: "m1", role: "user", content: "hi", parts: [], createdAt: "2026-01-01T00:00:00Z" },
          ],
          structured: [["req-1", { ok: true }]],
          promptJournal: [{ requestId: "req-1", state: "completed", acceptedAt: 3 }],
          steerJournal: [
            {
              requestId: "steer-dropped",
              inputDigest: "digest",
              expectedRunId: "pi:generation:1",
              state: "dropped",
              createdAt: 4,
            },
          ],
          composer: {
            models: [{ platform: "pi", id: "anthropic/claude-opus-4-5", label: "stale" }],
            selectedModelId: "anthropic/claude-opus-4-5",
            selectedReasoningId: "high",
            fastModeEnabled: null,
            fastModeAvailable: false,
            modes: [],
          },
        },
      ],
    });

    await loadPersistedState();

    const restored = sessions.get("session-1")!;
    expect(restored.sessionFile).toBe("/sessions/one.jsonl");
    expect(restored.revision).toBe(7);
    expect(restored.messages).toHaveLength(1);
    expect(restored.structured.get("req-1")).toEqual({ ok: true });
    expect(restored.steerJournal.get("steer-dropped")?.state).toBe("dropped");
    expect(clientSessionKeys.get("tab-1")).toBe("session-1");
    // The selection survives; the catalogue does not, because reviving a stale
    // one would offer models the account may no longer reach.
    expect(restored.composer.selectedModelId).toBe("anthropic/claude-opus-4-5");
    expect(restored.composer.selectedReasoningId).toBe("high");
    expect(restored.composer.models).toEqual([]);
  });

  test("restores the provider-measured durations and cost sources Pi reports", async () => {
    await writeState({
      version: 1,
      provider: "pi",
      sessions: [
        {
          id: "session-durations",
          status: "idle",
          revision: 1,
          messages: [
            {
              id: "m1",
              role: "assistant",
              content: "",
              createdAt: "2026-01-01T00:00:00Z",
              parts: [
                {
                  type: "tool-invocation",
                  content: "ls",
                  sourcePartId: "m1:0",
                  sourceMessageId: "m1",
                  toolUseId: "call-1",
                  toolState: "success",
                  toolDurationMs: 42,
                },
              ],
            },
          ],
          structured: [],
          promptJournal: [],
          usage: {
            turn: { inputTokens: 10, outputTokens: 5 },
            durationMs: 3_000,
            apiDurationMs: 2_000,
            costUsd: 0.04,
            costSource: "estimate",
            sessionCostParts: 3,
            sessionProviderCostParts: 2,
            turns: [
              {
                turnId: "t1",
                at: "2026-01-01T00:00:00.000Z",
                durationMs: 3_000,
                apiDurationMs: 2_000,
                costUsd: 0.03,
                costSource: "provider",
              },
              // A source that is not one of the two, or one with no amount
              // beside it, is not restored.
              { turnId: "t2", costUsd: 0.01, costSource: "billed" },
              { turnId: "t3", costSource: "provider" },
            ],
            updatedAt: "2026-01-01T00:00:00Z",
          },
        },
      ],
    });

    await loadPersistedState();

    const restored = sessions.get("session-durations")!;
    expect(restored.messages[0]?.parts[0]).toMatchObject({ toolDurationMs: 42 });
    expect(restored.usage).toMatchObject({
      durationMs: 3_000,
      apiDurationMs: 2_000,
      costUsd: 0.04,
      costSource: "estimate",
      // The next turn's source is derived from these counts.
      sessionCostParts: 3,
      sessionProviderCostParts: 2,
      // `at` dates recorded usage, so a turn kept across a restart must not
      // come back undated: the consumer would fall back to today.
      turns: [
        {
          turnId: "t1",
          at: "2026-01-01T00:00:00.000Z",
          durationMs: 3_000,
          apiDurationMs: 2_000,
          costUsd: 0.03,
          costSource: "provider",
        },
        { turnId: "t2", costUsd: 0.01 },
        { turnId: "t3" },
      ],
    });
    expect(restored.usage?.turns?.[1]).not.toHaveProperty("costSource");
    expect(restored.usage?.turns?.[2]).not.toHaveProperty("costSource");
  });

  test("downgrades a journal state it cannot vouch for", async () => {
    await writeState({
      version: 1,
      provider: "pi",
      sessions: [
        {
          id: "session-1",
          status: "idle",
          revision: 0,
          messages: [],
          structured: [],
          promptJournal: [{ requestId: "req-1", state: "accepted", acceptedAt: 1 }],
        },
      ],
    });

    await loadPersistedState();

    expect(sessions.get("session-1")!.promptJournal.get("req-1")!.state).toBe("ambiguous");
  });

  test("skips a structurally malformed session while restoring valid siblings", async () => {
    await writeState({
      version: 1,
      provider: "pi",
      sessions: [
        {
          id: "malformed",
          status: "idle",
          revision: 0,
          // `restoreTodos` walks parts. This used to throw here and abandon
          // every valid session that followed this entry in the shared file.
          messages: [{ id: "broken", role: "assistant" }],
          structured: [],
          promptJournal: [],
        },
        {
          id: "valid",
          clientSessionKey: "tab-valid",
          sessionFile: "/sessions/valid.jsonl",
          status: "idle",
          revision: 4,
          messages: [],
          structured: [],
          promptJournal: [],
        },
      ],
    });

    await loadPersistedState();

    expect(sessions.has("malformed")).toBe(false);
    expect(sessions.get("valid")?.sessionFile).toBe("/sessions/valid.jsonl");
    expect(clientSessionKeys.get("tab-valid")).toBe("valid");
  });

  test("loads a corrupt file as no sessions rather than throwing", async () => {
    await writeFile(join(directory, "state.json"), "{not json", "utf8");
    await loadPersistedState();
    expect(sessions.size).toBe(0);
  });

  test("ignores a state file another bridge wrote", async () => {
    await writeState({ version: 1, provider: "cursor", sessions: [{ id: "x" }] });
    await loadPersistedState();
    expect(sessions.size).toBe(0);
  });
});

test("does not persist tab-scoped MCP credentials", async () => {
  const state = newSessionState("mcp-key");
  state.agentMcp = { url: "http://127.0.0.1:4567/mcp", token: "do-not-persist" };
  sessions.set(state.id, state);
  schedulePersist();
  await drainPersistence();
  const raw = await readFile(join(directory, "state.json"), "utf8");
  expect(raw).not.toContain("agentMcp");
  expect(raw).not.toContain("do-not-persist");
});

test("preserves the read-only review restriction across bridge restart", async () => {
  const state = newSessionState("review-key");
  state.readOnly = true;
  sessions.set(state.id, state);
  schedulePersist();
  await drainPersistence();
  sessions.clear();
  clientSessionKeys.clear();
  await loadPersistedState();
  expect(sessions.get(state.id)?.readOnly).toBe(true);
});

test("keeps a session's auto-compaction choice across a restart, and omits an unset one", async () => {
  const off = newSessionState("auto-compaction-off");
  off.autoCompaction = false;
  const unset = newSessionState("auto-compaction-unset");
  // Pi's own setting is re-read after a restart, never restored from here.
  unset.autoCompactionSetting = false;
  sessions.set(off.id, off);
  sessions.set(unset.id, unset);
  schedulePersist();
  await drainPersistence();
  const written = await readState();
  expect(written.sessions.find((entry) => entry.id === off.id)?.autoCompaction).toBe(false);
  expect(written.sessions.find((entry) => entry.id === unset.id)).not.toHaveProperty(
    "autoCompaction",
  );
  sessions.clear();
  clientSessionKeys.clear();
  await loadPersistedState();
  expect(sessions.get(off.id)?.autoCompaction).toBe(false);
  expect(sessions.get(unset.id)?.autoCompaction).toBeUndefined();
  expect(sessions.get(unset.id)?.autoCompactionSetting).toBeUndefined();
});

test("restores the command list as stale, with no path, and still validates a selection", async () => {
  const path = "/home/someone/.pi/agent/prompts/review.md";
  const state = newSessionState("commands-key");
  publishCommandCatalogue(
    state,
    buildCommandCatalogue({
      promptTemplates: [
        {
          name: "review",
          description: "Review",
          content: "Review $@",
          filePath: path,
          sourceInfo: { path, source: "local", scope: "user", origin: "top-level" },
        },
      ],
    } as unknown as AgentSession),
  );
  const row = state.slashCommands[0]!;
  sessions.set(state.id, state);
  schedulePersist();
  await drainPersistence();

  const raw = await readFile(join(directory, "state.json"), "utf8");
  expect(raw).not.toContain(path);

  sessions.clear();
  clientSessionKeys.clear();
  await loadPersistedState();
  const restored = sessions.get(state.id)!;
  expect(restored.slashCommands).toEqual([row]);
  // Resources may have changed while the bridge was down; the next attach
  // re-reads them and only then is the list authoritative again.
  expect(restored.commandCatalogue.status).toBe("stale");
  expect(
    resolveCommandSelection(restored, {
      id: row.id!,
      name: row.name,
      executionKind: "provider-prompt",
      bindingRevision: row.bindingRevision!,
      arguments: "x",
    }),
  ).toMatchObject({ ok: true, kind: "template", text: "/review x" });
});

test("drops restored command rows that do not name a Pi binding", async () => {
  await writeState({
    version: 1,
    provider: "pi",
    sessions: [
      {
        id: "restored-commands",
        status: "idle",
        messages: [],
        revision: 1,
        structured: [],
        promptJournal: [],
        commands: [
          {
            name: "/review",
            id: "pi:template:review",
            executionKind: "provider-prompt",
            source: "template",
          },
          // The id names a different command than the row claims.
          {
            name: "/deploy",
            id: "pi:template:review2",
            executionKind: "provider-prompt",
            source: "template",
          },
          {
            name: "/steer",
            id: "orkestrator:steer",
            executionKind: "session-action",
            source: "orkestrator",
          },
          { name: "has space", id: "pi:template:x", executionKind: "provider-prompt" },
        ],
      },
    ],
  });
  await loadPersistedState();
  expect(sessions.get("restored-commands")?.slashCommands.map((command) => command.id)).toEqual([
    "pi:template:review",
  ]);
});

test("a preview's rows restore still marked as waiting for the attach", async () => {
  const state = newSessionState();
  state.slashCommands = [
    {
      name: "/review",
      id: "pi:template:review",
      executionKind: "provider-prompt",
      source: "template",
    },
  ];
  state.commandCatalogue = { status: "stale", revision: 1, attachPending: true };
  sessions.set(state.id, state);
  schedulePersist();
  await drainPersistence();
  const entry = (await readState()).sessions.find((session) => session.id === state.id);
  expect(entry?.commandsAttachPending).toBe(true);

  sessions.clear();
  await loadPersistedState();
  // Restored rows still lack extension commands, so the picker keeps saying so.
  expect(sessions.get(state.id)?.commandCatalogue).toEqual({
    status: "stale",
    revision: 0,
    attachPending: true,
  });
});

describe("a rewound Pi leaf", () => {
  const restorable = (id: string) => ({
    id,
    messages: [],
    revision: 0,
    structured: [],
    promptJournal: [],
  });

  test("survives a restart until something is appended under it", async () => {
    const state = newSessionState("rewound");
    state.sessionFile = "/sessions/rewound.jsonl";
    state.historyLeaf = { entryId: "a1", entries: 6 };
    sessions.set(state.id, state);
    await persistBarrier();
    sessions.clear();
    clientSessionKeys.clear();

    await loadPersistedState();
    expect(sessions.get(state.id)?.historyLeaf).toEqual({ entryId: "a1", entries: 6 });
  });

  test("a rewind to before the first prompt keeps its null leaf; a malformed one is dropped", async () => {
    await writeState({
      version: 1,
      provider: "pi",
      sessions: [
        { ...restorable("to-start"), historyLeaf: { entryId: null, entries: 2 } },
        { ...restorable("malformed"), historyLeaf: { entryId: 7, entries: -1 } },
      ],
    });
    await loadPersistedState();
    expect(sessions.get("to-start")?.historyLeaf).toEqual({ entryId: null, entries: 2 });
    expect(sessions.get("malformed")?.historyLeaf).toBeUndefined();
  });
});
