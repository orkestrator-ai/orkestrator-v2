/**
 * E02 residuals: how one publication reaches disk, and what the queue promises
 * around it.
 *
 * - Every write uses its own temporary file, flushed before the rename, and
 *   the directory is flushed after it. A write, flush, rename or permission
 *   failure each leaves the previous snapshot byte-identical and loadable.
 * - Leftover temporary files from a killed bridge are swept, boundedly.
 * - A failure episode re-notifies (and re-revisions) only sessions whose
 *   notice actually changes.
 * - Essential overflow refuses a prompt before the SDK sees it; a prepared
 *   prompt behind a running write waits for the write that contains it;
 *   shutdown racing a settling run has one writer and no unhandled rejection.
 * - A restore charges the transcript without re-encoding it, and the first
 *   read bounds it before serving it.
 *
 * Every filesystem failure is injected through the persistence module's seam;
 * serialization, the queue and the routes are production code.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import {
  readdir,
  readFile,
  rename as realRename,
  utimes,
  writeFile as realWriteFile,
} from "node:fs/promises";
import { join } from "node:path";
import { newSessionState } from "./agent-session.js";
import { MAX_MESSAGES } from "./config.js";
import {
  drainPersistence,
  loadPersistedState,
  persistBarrier,
  persistBarrierWaitersForTests,
  reopenPersistenceForTests,
  schedulePersist,
  usePersistenceFsForTests,
} from "./persistence.js";
import { setStructuredResult } from "./structured-results.js";
import { clientSessionKeys, sessions, type BridgeMessage, type SessionState } from "./state.js";
import { attachFake } from "./testing/fake-agent.js";
import {
  deferred,
  holdPublication,
  startRouterHarness,
  waitFor,
  type RouterHarness,
} from "./testing/router-harness.js";

const MiB = 1024 * 1024;

let harness: RouterHarness;
let warn: Mock<typeof console.warn>;

beforeEach(async () => {
  harness = await startRouterHarness();
  warn = spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  try {
    await harness.close();
  } finally {
    warn.mockRestore();
  }
});

function register(state: SessionState): SessionState {
  sessions.set(state.id, state);
  if (state.clientSessionKey) clientSessionKeys.set(state.clientSessionKey, state.id);
  return state;
}

function errno(code: string): Error {
  // The message carries a path, as a real filesystem error would.
  return Object.assign(new Error(`${code}: ${harness.stateRoot}/state.json`), { code });
}

async function temporaries(): Promise<string[]> {
  return (await readdir(harness.stateRoot)).filter((name) => name.endsWith(".tmp")).sort();
}

function textMessage(id: string, text: string): BridgeMessage {
  return {
    id,
    role: "assistant",
    content: text,
    parts: [{ type: "text", content: text, sourcePartId: `${id}:0`, sourceMessageId: id }],
    createdAt: new Date(0).toISOString(),
  };
}

describe("one publication", () => {
  test("writes a unique temporary file, flushes it, renames it, then flushes the directory", async () => {
    register(newSessionState("client-a"));
    const calls: string[] = [];
    const temporaryNames: string[] = [];
    const restore = usePersistenceFsForTests({
      writeFile: (async (...args: Parameters<typeof realWriteFile>) => {
        const [path, , options] = args;
        temporaryNames.push(String(path));
        calls.push("write");
        // Created exclusively: a name collision fails instead of truncating.
        expect(options).toMatchObject({ flag: "wx", mode: 0o600 });
        return realWriteFile(...args);
      }) as typeof realWriteFile,
      fsyncFile: async (path: string) => {
        calls.push(`flush:${path === temporaryNames.at(-1) ? "temporary" : path}`);
      },
      rename: (async (...args: Parameters<typeof realRename>) => {
        calls.push("rename");
        return realRename(...args);
      }) as typeof realRename,
      fsyncDirectory: async (path: string) => {
        calls.push(`flush-directory:${path === harness.stateRoot ? "state-root" : path}`);
      },
    });
    try {
      await persistBarrier();
      await persistBarrier();
    } finally {
      restore();
    }
    expect(calls).toEqual([
      "write",
      "flush:temporary",
      "rename",
      "flush-directory:state-root",
      "write",
      "flush:temporary",
      "rename",
      "flush-directory:state-root",
    ]);
    expect(temporaryNames).toHaveLength(2);
    expect(new Set(temporaryNames).size).toBe(2);
    for (const name of temporaryNames) {
      // Beside the state file, so the rename never crosses a filesystem.
      expect(name.startsWith(`${harness.stateFile}.${process.pid}.`)).toBe(true);
      expect(name.endsWith(".tmp")).toBe(true);
    }
    expect(await temporaries()).toEqual([]);
    expect(await harness.readPublished()).toMatchObject({ provider: "cursor" });
  });

  test("the real flushes run on this platform", async () => {
    register(newSessionState("client-a"));
    // No seam: the production file and directory flush must succeed (or be
    // an ignored unsupported-directory error) on the machine running this.
    await persistBarrier();
    expect(await harness.readPublished()).toMatchObject({ provider: "cursor" });
    expect(await temporaries()).toEqual([]);
  });

  const failures: Array<{
    name: string;
    inject: (error: Error) => Partial<Parameters<typeof usePersistenceFsForTests>[0]>;
    code: string;
  }> = [
    {
      name: "the temporary write",
      code: "EIO",
      inject: (error) => ({
        writeFile: (async (...args: Parameters<typeof realWriteFile>) => {
          // A torn write: part of the file lands, then the device fails.
          await realWriteFile(args[0], '{"partial', { mode: 0o600, flag: "wx" });
          throw error;
        }) as typeof realWriteFile,
      }),
    },
    {
      name: "the permission to create it",
      code: "EACCES",
      inject: (error) => ({
        writeFile: (async () => {
          throw error;
        }) as unknown as typeof realWriteFile,
      }),
    },
    {
      name: "the flush",
      code: "EIO",
      inject: (error) => ({
        fsyncFile: async () => {
          throw error;
        },
      }),
    },
    {
      name: "the rename",
      code: "EXDEV",
      inject: (error) => ({
        rename: (async () => {
          throw error;
        }) as unknown as typeof realRename,
      }),
    },
  ];

  for (const failure of failures) {
    test(`a failure of ${failure.name} leaves the previous snapshot authoritative`, async () => {
      const state = register(newSessionState("client-a"));
      state.agentId = "agent-a";
      state.composer = { ...state.composer, selectedModelId: "published" };
      await persistBarrier();
      const before = await readFile(harness.stateFile);

      state.composer = { ...state.composer, selectedModelId: "never-published" };
      const restore = usePersistenceFsForTests(failure.inject(errno(failure.code)));
      try {
        await expect(persistBarrier()).rejects.toMatchObject({ code: "persistence-failed" });
      } finally {
        restore();
      }
      // Byte-identical, and no temporary file left behind.
      expect(Buffer.compare(await readFile(harness.stateFile), before)).toBe(0);
      expect(await temporaries()).toEqual([]);
      // Content-free: the injected path never reaches the log.
      for (const call of warn.mock.calls) expect(String(call[0])).not.toContain(harness.stateRoot);
      expect(warn.mock.calls.some((call) => String(call[0]).includes(failure.code))).toBe(true);

      // A successor reads the previous snapshot.
      sessions.clear();
      clientSessionKeys.clear();
      await loadPersistedState();
      const restored = sessions.get(state.id)!;
      expect(restored.agentId).toBe("agent-a");
      expect(restored.composer.selectedModelId).toBe("published");
    });
  }

  test("an unsupported directory flush is tolerated; a failing one is not", async () => {
    const state = register(newSessionState("client-a"));
    let directoryError: Error | undefined = errno("EINVAL");
    const restore = usePersistenceFsForTests({
      fsyncDirectory: async () => {
        if (directoryError) throw directoryError;
      },
    });
    try {
      for (const code of ["EISDIR", "EPERM", "EINVAL", "ENOTSUP"]) {
        directoryError = errno(code);
        state.composer = { ...state.composer, selectedModelId: code };
        await persistBarrier();
        expect(await harness.readPublished()).toMatchObject({
          sessions: [{ composer: { selectedModelId: code } }],
        });
      }

      // A real flush failure after the rename: the file is already replaced,
      // but the caller did not get the durable write it asked for.
      directoryError = errno("EIO");
      state.composer = { ...state.composer, selectedModelId: "not-durable" };
      await expect(persistBarrier()).rejects.toMatchObject({ code: "persistence-failed" });
      expect(await harness.readPublished()).toMatchObject({
        sessions: [{ composer: { selectedModelId: "not-durable" } }],
      });
      expect(await temporaries()).toEqual([]);
    } finally {
      restore();
    }
  });
});

describe("temporary files left by a killed bridge", () => {
  test("stale leftovers are removed; a live writer's file and unrelated names are not", async () => {
    register(newSessionState("client-a"));
    const old = new Date(Date.now() - 60 * 60 * 1_000);
    const names = {
      legacy: "state.json.tmp",
      otherStale: "state.json.999999.3.deadbeef.tmp",
      otherFresh: "state.json.999998.1.cafebabe.tmp",
      ownLeftover: `state.json.${process.pid}.1.0badf00d.tmp`,
      unrelated: "state.json.backup.tmp",
      otherFile: "notes.tmp",
    };
    for (const name of Object.values(names)) {
      await realWriteFile(join(harness.stateRoot, name), "leftover");
    }
    for (const name of [names.legacy, names.otherStale, names.unrelated, names.otherFile]) {
      await utimes(join(harness.stateRoot, name), old, old);
    }

    await persistBarrier();

    expect(await temporaries()).toEqual(
      [names.otherFresh, names.unrelated, names.otherFile].sort(),
    );
    expect(await harness.readPublished()).toMatchObject({ provider: "cursor" });
  });

  test("the sweep is bounded to once per interval", async () => {
    register(newSessionState("client-a"));
    let listings = 0;
    const restore = usePersistenceFsForTests({
      readdir: async (path: string) => {
        listings += 1;
        return readdir(path);
      },
    });
    try {
      for (let index = 0; index < 5; index += 1) await persistBarrier();
    } finally {
      restore();
    }
    expect(listings).toBe(1);
  });
});

describe("failure notices", () => {
  test("a changed largest-session set re-notifies only the sessions whose notice changed", async () => {
    const keeper = register(newSessionState("client-keeper"));
    const heavy: SessionState[] = [];
    for (let session = 0; session < 9; session += 1) {
      const state = register(newSessionState(`client-heavy-${session}`));
      for (let index = 0; index < 4; index += 1) {
        setStructuredResult(state, `r-${index}`, {
          ok: true,
          requestId: `r-${index}`,
          value: "v".repeat(MiB - 64 * 1024),
        });
      }
      heavy.push(state);
    }
    const first = await persistBarrier().then(
      () => undefined,
      (error: unknown) => error as { code: string; sessionIds: string[] },
    );
    expect(first?.code).toBe("persistence-budget-exceeded");
    expect(first!.sessionIds).toHaveLength(1);
    const firstOffender = sessions.get(first!.sessionIds[0]!)!;

    const revisions = new Map(Array.from(sessions.values(), (state) => [state, state.revision]));
    const counts = (state: SessionState) =>
      state.health
        .listNotices()
        .filter((notice) => notice.method === "persistence")
        .map((notice) => notice.count);
    const keeperCounts = counts(keeper);
    expect(keeperCounts).toEqual([1]);

    // Same failure, still unresolved: nothing re-notified, no revision moved.
    await expect(persistBarrier()).rejects.toMatchObject({ code: "persistence-budget-exceeded" });
    for (const [state, revision] of revisions) expect(state.revision).toBe(revision);

    // Shrink the offender: still over budget, but a different session is now
    // the largest.
    firstOffender.structured.delete("r-0");
    const second = await persistBarrier().then(
      () => undefined,
      (error: unknown) => error as { code: string; sessionIds: string[] },
    );
    expect(second?.code).toBe("persistence-budget-exceeded");
    const secondOffender = sessions.get(second!.sessionIds[0]!)!;
    expect(secondOffender).not.toBe(firstOffender);

    const changed = new Set([firstOffender, secondOffender]);
    for (const [state, revision] of revisions) {
      if (changed.has(state)) {
        expect(state.revision).toBe(revision + 1);
      } else {
        // A bystander's notice text is unchanged, so its transcript token is
        // not invalidated and no second occurrence is recorded.
        expect(state.revision).toBe(revision);
      }
    }
    expect(counts(keeper)).toEqual(keeperCounts);
    // The first offender is told it is no longer the largest (the generic
    // notice again); the new one is told it now is.
    expect(
      secondOffender.health.listNotices().some((notice) => notice.message.includes("largest")),
    ).toBe(true);

    // Recovery ends the episode; a later failure notifies everyone again.
    for (const state of heavy) {
      sessions.delete(state.id);
      clientSessionKeys.delete(state.clientSessionKey!);
    }
    await persistBarrier();
    const keeperRevision = keeper.revision;
    const restore = usePersistenceFsForTests({
      writeFile: (async () => {
        throw errno("EIO");
      }) as unknown as typeof realWriteFile,
    });
    try {
      await expect(persistBarrier()).rejects.toMatchObject({ code: "persistence-failed" });
    } finally {
      restore();
    }
    expect(keeper.revision).toBe(keeperRevision + 1);
  });
});

describe("dispatch around the write queue", () => {
  function prompt(state: SessionState, requestId: string): Promise<Response> {
    return harness.call(`/session/${state.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt: "synthetic prompt", requestId }),
    });
  }

  test("essential state over budget refuses the prompt and the SDK is never called", async () => {
    const state = await harness.createSession({ clientSessionKey: "tab-a" });
    const agent = attachFake(state);
    await persistBarrier();
    const before = await readFile(harness.stateFile);
    // Recovery state elsewhere fills the file; structured results are never shed.
    for (let session = 0; session < 9; session += 1) {
      const heavy = register(newSessionState(`client-heavy-${session}`));
      for (let index = 0; index < 4; index += 1) {
        setStructuredResult(heavy, `r-${index}`, {
          ok: true,
          requestId: `r-${index}`,
          value: "v".repeat(MiB - 64 * 1024),
        });
      }
    }

    const response = await prompt(state, "over-budget-1");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      kind: "persistence-unavailable",
      code: "persistence-budget-exceeded",
    });
    expect(agent.sends).toHaveLength(0);
    expect(state.promptJournal.has("over-budget-1")).toBe(false);
    expect(state.dispatching).toBe(false);
    expect(Buffer.compare(await readFile(harness.stateFile), before)).toBe(0);
  });

  test("a prepared prompt behind a running write waits for the write that contains it", async () => {
    const state = await harness.createSession({ clientSessionKey: "tab-a" });
    const holdSend = deferred();
    const agent = attachFake(state, { holdSend: holdSend.promise });
    const hold = holdPublication();
    let renamesAtSend: number | undefined;
    const send = agent.send.bind(agent);
    (agent as { send: typeof agent.send }).send = ((...args: Parameters<typeof agent.send>) => {
      renamesAtSend ??= hold.renames();
      return send(...args);
    }) as typeof agent.send;
    try {
      // A best-effort write is already running, from before the request.
      schedulePersist();
      await hold.held;
      const response = prompt(state, "behind-1");
      await waitFor(() => persistBarrierWaitersForTests() === 1);
      expect(state.promptJournal.get("behind-1")?.state).toBe("prepared");
      expect(agent.sends).toHaveLength(0);

      // Completing the older write must not release the barrier on its own;
      // only the next write, whose snapshot includes the record, does.
      hold.release();
      await waitFor(() => agent.sends.length === 1);
      // At the moment `send` was called, a second publication — the first
      // whose snapshot followed the request — had completed.
      expect(renamesAtSend).toBeGreaterThanOrEqual(2);
      expect(hold.maxConcurrentWrites()).toBe(1);
      const published = (await harness.readPublished()) as {
        sessions: Array<{ promptJournal: Array<{ requestId: string; state: string }> }>;
      };
      expect(published.sessions[0]!.promptJournal).toContainEqual(
        expect.objectContaining({ requestId: "behind-1", state: "ambiguous" }),
      );
      holdSend.resolve();
      expect((await response).status).toBe(202);
    } finally {
      holdSend.resolve();
      hold.restore();
    }
  });

  test("shutdown racing a settling run has one writer, no unhandled rejection and a valid final file", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const state = await harness.createSession({ clientSessionKey: "tab-a" });
    const run = deferred();
    attachFake(state, { hold: run.promise, result: "done" });
    let hold: ReturnType<typeof holdPublication> | undefined;
    try {
      expect((await prompt(state, "settling-1")).status).toBe(202);
      expect(state.status).toBe("running");

      hold = holdPublication();
      schedulePersist();
      await hold.held;
      const drained = drainPersistence();
      // The run settles while the drain waits on the in-flight write: its own
      // best-effort writes are refused, and its mutations belong to the final
      // snapshot instead.
      run.resolve();
      await waitFor(() => state.status === "idle");
      await expect(persistBarrier()).rejects.toMatchObject({ code: "persistence-closed" });
      hold.release();
      await drained;
      for (let index = 0; index < 10; index += 1) await Promise.resolve();

      expect(hold.maxConcurrentWrites()).toBe(1);
      expect(hold.writes()).toBe(2);
      const published = (await harness.readPublished()) as {
        sessions: Array<{
          status: string;
          promptJournal: Array<{ requestId: string; state: string }>;
        }>;
      };
      expect(published.sessions[0]!.status).toBe("idle");
      expect(published.sessions[0]!.promptJournal).toContainEqual(
        expect.objectContaining({ requestId: "settling-1", state: "completed" }),
      );
      expect(await temporaries()).toEqual([]);
      expect(unhandled).toEqual([]);
    } finally {
      run.resolve();
      hold?.restore();
      process.off("unhandledRejection", onUnhandled);
      reopenPersistenceForTests();
    }
  });
});

describe("restore", () => {
  test("charges a restored transcript without re-encoding it, and the first read bounds it", async () => {
    const count = MAX_MESSAGES + 20;
    const messages = Array.from({ length: count }, (_, index) => textMessage(`m${index}`, "hi"));
    const raw = JSON.stringify({
      version: 1,
      provider: "cursor",
      sessions: [
        {
          id: "restored-1",
          status: "idle",
          messages,
          revision: 3,
          structured: [],
          promptJournal: [],
        },
        {
          id: "restored-empty",
          status: "idle",
          messages: [],
          revision: 1,
          structured: [],
          promptJournal: [],
        },
      ],
    });
    await realWriteFile(harness.stateFile, raw);
    await loadPersistedState();

    const restored = sessions.get("restored-1")!;
    // An upper bound taken from the bytes already read, not a re-encoding.
    expect(restored.uncheckedTranscriptBytes).toBe(Buffer.byteLength(raw));
    expect(sessions.get("restored-empty")!.uncheckedTranscriptBytes).toBe(0);
    expect(restored.messages).toHaveLength(count);

    // Served only after it is bounded.
    const response = await harness.call(`/session/${restored.id}/messages`);
    expect(response.status).toBe(200);
    expect(restored.messages).toHaveLength(MAX_MESSAGES);
    expect(restored.droppedMessages).toBe(20);
    expect(restored.transcriptTruncated).toBe(true);
    expect(restored.uncheckedTranscriptBytes).toBe(0);
    expect(restored.revision).toBe(4);
  });
});
