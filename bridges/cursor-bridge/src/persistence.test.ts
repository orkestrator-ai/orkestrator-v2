/**
 * Persistence is exercised against a real state file in a temporary directory.
 *
 * The state path is resolved per call rather than frozen at import, so this
 * file sets and clears the variable around each test instead of depending on
 * being imported before anything else — a dependency that would pass alone and
 * fail in the aggregate suite.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { newSessionState } from "./agent-session.js";
import { drainPersistence, loadPersistedState } from "./persistence.js";
import { clientSessionKeys, sessionIsWorking, sessions, type BridgeToolPart } from "./state.js";

let stateRoot: string;
let stateFile: string;
const previousStateDir = process.env.CURSOR_BRIDGE_STATE_DIR;

beforeEach(async () => {
  sessions.clear();
  clientSessionKeys.clear();
  stateRoot = await mkdtemp(path.join(tmpdir(), "cursor-bridge-persist-"));
  stateFile = path.join(stateRoot, "state.json");
  process.env.CURSOR_BRIDGE_STATE_DIR = stateRoot;
});

afterEach(async () => {
  sessions.clear();
  clientSessionKeys.clear();
  // Restored rather than merely deleted: leaving it set would have any other
  // suite in this process start writing state files into a temp directory.
  if (previousStateDir === undefined) delete process.env.CURSOR_BRIDGE_STATE_DIR;
  else process.env.CURSOR_BRIDGE_STATE_DIR = previousStateDir;
  await rm(stateRoot, { recursive: true, force: true });
});

async function persist(): Promise<Record<string, unknown>> {
  await drainPersistence();
  return JSON.parse(await readFile(stateFile, "utf8")) as Record<string, unknown>;
}

describe("round trip", () => {
  test("restores the transcript, composer selection and client key", async () => {
    const state = newSessionState("client-key");
    state.agentId = "agent-1";
    state.composer = { ...state.composer, selectedModelId: "composer-2.5", selectedModeId: "plan" };
    state.messages.push({
      id: "m0",
      role: "user",
      content: "hello",
      parts: [{ type: "text", content: "hello", sourcePartId: "m0:0", sourceMessageId: "m0" }],
      createdAt: new Date(0).toISOString(),
    });
    state.revision = 7;
    sessions.set(state.id, state);

    await persist();
    sessions.clear();
    clientSessionKeys.clear();
    await loadPersistedState();

    const restored = sessions.get(state.id)!;
    expect(restored.agentId).toBe("agent-1");
    expect(restored.clientSessionKey).toBe("client-key");
    expect(clientSessionKeys.get("client-key")).toBe(state.id);
    expect(restored.messages).toHaveLength(1);
    expect(restored.revision).toBe(7);
    expect(restored.composer.selectedModelId).toBe("composer-2.5");
    expect(restored.composer.selectedModeId).toBe("plan");
    // The catalogue is a live read; a stale one would offer models the account
    // may no longer have.
    expect(restored.composer.models).toEqual([]);
    // Nothing about the dead process survives.
    expect(restored.agent).toBeNull();
    expect(restored.dispatching).toBe(false);
  });

  test("a session that was mid-turn is restored idle, never running", async () => {
    const state = newSessionState();
    state.status = "running";
    sessions.set(state.id, state);

    const payload = (await persist()) as { sessions: Array<{ status: string }> };
    expect(payload.sessions[0]!.status).toBe("idle");
  });

  test("re-measures the restored transcript instead of trusting a stale budget", async () => {
    const state = newSessionState();
    state.messages.push({
      id: "m0",
      role: "assistant",
      content: "x".repeat(500),
      parts: [],
      createdAt: new Date(0).toISOString(),
    });
    sessions.set(state.id, state);
    await persist();
    sessions.clear();
    await loadPersistedState();

    expect(sessions.get(state.id)!.uncheckedTranscriptBytes).toBeGreaterThan(400);
  });
});

describe("the prompt journal across a restart", () => {
  test("downgrades an unfinished turn to ambiguous", async () => {
    const state = newSessionState();
    state.promptJournal.set("accepted", {
      requestId: "accepted",
      state: "accepted",
      acceptedAt: 1,
    });
    state.promptJournal.set("prepared", {
      requestId: "prepared",
      state: "prepared",
      acceptedAt: 2,
    });
    state.promptJournal.set("done", { requestId: "done", state: "completed", acceptedAt: 3 });
    state.promptJournal.set("failed", { requestId: "failed", state: "failed", acceptedAt: 4 });
    sessions.set(state.id, state);

    await persist();
    sessions.clear();
    await loadPersistedState();

    const journal = sessions.get(state.id)!.promptJournal;
    // Neither of these has a recorded outcome, so the successor must refuse to
    // reuse the id rather than re-run work that may already have happened.
    expect(journal.get("accepted")!.state).toBe("ambiguous");
    expect(journal.get("prepared")!.state).toBe("ambiguous");
    // A settled outcome is knowledge and survives as itself.
    expect(journal.get("done")!.state).toBe("completed");
    expect(journal.get("failed")!.state).toBe("failed");
  });
});

describe("sub-agent cards after a restart", () => {
  function sessionWithSubagentCard(
    toolState: "pending" | "success",
    agentState: "active" | "finished",
    toolOutput?: string,
  ) {
    const state = newSessionState();
    state.messages.push({
      id: "m1",
      role: "assistant",
      content: "",
      createdAt: new Date(0).toISOString(),
      parts: [
        {
          type: "tool-invocation",
          content: "Task",
          sourcePartId: "m1:0",
          sourceMessageId: "m1",
          toolUseId: "call-1",
          toolName: "task",
          toolState,
          agentState,
          ...(toolOutput === undefined ? {} : { toolOutput }),
        },
      ],
    });
    sessions.set(state.id, state);
    return state;
  }

  async function reload(id: string) {
    await persist();
    sessions.clear();
    clientSessionKeys.clear();
    await loadPersistedState();
    return sessions.get(id)!;
  }

  /**
   * `activeSubagentDescriptors` is not persisted — a live child belongs to the
   * process that launched it — so nothing after a restart can ever settle a
   * card left at `active`. Left alone it renders as a sub-agent that has been
   * running since before the bridge started, and disagrees with `/activity`,
   * which correctly reports the session idle.
   */
  test("a card left active by a dead process is settled as detached", async () => {
    const state = sessionWithSubagentCard("pending", "active");

    const part = (await reload(state.id)).messages[0]!.parts[0] as BridgeToolPart;
    expect(part.agentState).toBe("finished");
    expect(part.toolState).toBe("success");
    // Detached, not completed: claiming it finished would be a claim about work
    // this process never observed.
    expect(part.toolOutput).toContain("still running in the background");
  });

  test("the settled card does not make the session look busy", async () => {
    const state = sessionWithSubagentCard("pending", "active");
    const restored = await reload(state.id);

    expect(sessionIsWorking(restored)).toBe(false);
    expect(restored.activeSubagentDescriptors.size).toBe(0);
  });

  test("appends its note rather than discarding output the child produced", async () => {
    const state = sessionWithSubagentCard("pending", "active", "partial output");

    const part = (await reload(state.id)).messages[0]!.parts[0] as BridgeToolPart;
    expect(part.toolOutput).toStartWith("partial output");
    expect(part.toolOutput).toContain("still running in the background");
  });

  test("a card that already settled is left exactly as it was", async () => {
    const state = sessionWithSubagentCard("success", "finished", "done");

    const part = (await reload(state.id)).messages[0]!.parts[0] as BridgeToolPart;
    expect(part.toolOutput).toBe("done");
    expect(part.agentState).toBe("finished");
  });
});

describe("recovering the todo list", () => {
  test("rebuilds it from the newest card that carried one", async () => {
    const state = newSessionState();
    state.messages.push(
      {
        id: "m0",
        role: "assistant",
        content: "",
        parts: [
          {
            type: "tool-invocation",
            content: "Todos",
            sourcePartId: "m0:0",
            sourceMessageId: "m0",
            toolUseId: "t0",
            toolName: "updateTodos",
            toolArgs: { todos: [{ content: "old", status: "pending" }] },
          },
        ],
        createdAt: new Date(0).toISOString(),
      },
      {
        id: "m1",
        role: "assistant",
        content: "",
        parts: [
          {
            type: "tool-invocation",
            content: "Todos",
            sourcePartId: "m1:0",
            sourceMessageId: "m1",
            toolUseId: "t1",
            toolName: "updateTodos",
            toolArgs: { todos: [{ content: "new", status: "in_progress" }] },
          },
        ],
        createdAt: new Date(0).toISOString(),
      },
    );
    sessions.set(state.id, state);

    await persist();
    sessions.clear();
    await loadPersistedState();

    expect(sessions.get(state.id)!.todos).toEqual([{ content: "new", status: "in_progress" }]);
  });
});

describe("a damaged state file", () => {
  test("loads as no sessions rather than throwing", async () => {
    await writeFile(stateFile, "{not json");
    await loadPersistedState();
    expect(sessions.size).toBe(0);
  });

  test("ignores a file written by a different provider", async () => {
    await writeFile(
      stateFile,
      JSON.stringify({ version: 1, provider: "grok", sessions: [{ id: "x" }] }),
    );
    await loadPersistedState();
    expect(sessions.size).toBe(0);
  });

  test("skips entries with no id instead of restoring a nameless session", async () => {
    await writeFile(
      stateFile,
      JSON.stringify({ version: 1, provider: "cursor", sessions: [{ status: "idle" }, null] }),
    );
    await loadPersistedState();
    expect(sessions.size).toBe(0);
  });

  test("writes the state file owner-only", async () => {
    sessions.set("s", newSessionState());
    await persist();
    const { mode } = await stat(stateFile);
    expect(mode & 0o077).toBe(0);
  });
});
