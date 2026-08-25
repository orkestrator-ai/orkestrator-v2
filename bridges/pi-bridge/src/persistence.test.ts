import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newSessionState } from "./agent-session.js";
import { drainPersistence, loadPersistedState, schedulePersist } from "./persistence.js";
import { clientSessionKeys, sessions, type PersistedState } from "./state.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pi-bridge-persistence-"));
  process.env.PI_BRIDGE_STATE_DIR = directory;
  sessions.clear();
  clientSessionKeys.clear();
});

afterEach(async () => {
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

  test("never persists a parked approval", async () => {
    const state = newSessionState();
    state.approvals.set("a1", {
      id: "a1",
      toolCallId: "call-1",
      toolName: "bash",
      input: {},
      createdAt: 1,
      expiresAt: 2,
      settle: () => undefined,
    });
    sessions.set(state.id, state);

    schedulePersist();
    await drainPersistence();

    // An approval is a promise held by a process that no longer exists. There
    // is nothing a successor could do with it but deny it, so it is not stored.
    expect(JSON.stringify(await readState())).not.toContain("call-1");
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
    expect(clientSessionKeys.get("tab-1")).toBe("session-1");
    // The selection survives; the catalogue does not, because reviving a stale
    // one would offer models the account may no longer reach.
    expect(restored.composer.selectedModelId).toBe("anthropic/claude-opus-4-5");
    expect(restored.composer.selectedReasoningId).toBe("high");
    expect(restored.composer.models).toEqual([]);
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
