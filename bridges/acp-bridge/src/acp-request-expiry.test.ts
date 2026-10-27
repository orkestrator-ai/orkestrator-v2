import "./testing/unit-test-env.js";
import { afterAll, beforeAll, describe, expect, jest, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { RuntimeHealthRecorder } from "@orkestrator/protocol/runtime-health";
import { authToken, sessions, type AcpProcess, type SessionState } from "./acp-context.js";
import { route } from "./acp-http.js";
import { emptySessionConfig } from "./acp-persistence.js";
import { attachChild, clearApprovals, parkGrokInteraction } from "./acp-session.js";
import { nativeFetch, waitFor } from "./acp-test-harness.js";
import { publicApprovals } from "./acp-public.js";
import { configureCommandChanges } from "./acp-command-changes.js";

let server: Server;
let base: string;
const headers = { authorization: `Bearer ${authToken}`, "content-type": "application/json" };
beforeAll(async () => {
  configureCommandChanges({ probe: null });
  server = createServer((request, response) => {
    void route(request, response, new AbortController().signal).catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function fixture() {
  let complete!: (result: unknown) => void;
  const responses: unknown[] = [];
  const child = {
    request: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
    respond: (_id: number, result: unknown) => responses.push(result),
  } as unknown as AcpProcess;
  const state: SessionState = {
    id: "expiry-test",
    acpSessionId: "vendor-session",
    status: "idle",
    messages: [],
    activeSubagentToolIds: new Set(),
    activeSubagentDescriptors: new Map(),
    settledCursorAgentIds: new Set(),
    subagentLimitExceeded: false,
    subagentToolIds: new Map(),
    cursorTodos: [],
    historyMessageIds: new Map(),
    child,
    revision: 0,
    structured: new Map(),
    promptJournal: new Map(),
    grokInterjectionJournal: new Map(),
    approvals: new Map(),
    interactions: new Map(),
    outputTruncated: false,
    uncheckedTranscriptBytes: 0,
    currentTurnOutput: null,
    promptSequence: 0,
    droppedMessages: 0,
    droppedParts: 0,
    transcriptTruncated: false,
    sessionConfig: emptySessionConfig(),
    dispatching: false,
    historyReplay: false,
    health: new RuntimeHealthRecorder(),
  };
  attachChild(state, child);
  sessions.set(state.id, state);
  return { state, child, responses, complete: () => complete({ stopReason: "end_turn" }) };
}

async function start(state: SessionState, requestId: string) {
  const response = await nativeFetch(`${base}/session/${state.id}/prompt`, {
    method: "POST",
    headers,
    body: JSON.stringify({ prompt: "continue", requestId }),
  });
  expect(response.status).toBe(202);
}
async function outcome(state: SessionState, requestId: string) {
  const response = await nativeFetch(
    `${base}/session/${state.id}/dispatch?requestId=${requestId}`,
    { headers },
  );
  expect(response.status).toBe(200);
  return response.json() as Promise<{ dispatch: string; turn?: { state: string; error?: string } }>;
}
async function finished(state: SessionState, requestId: string) {
  return waitFor(
    () => outcome(state, requestId),
    (body) => body.turn !== undefined,
  );
}
/**
 * The tool call each approval kind parks for. A call without the detail its
 * kind needs (here, an edit with no path) stays a generic permission.
 */
const APPROVAL_CALLS: Record<string, { toolCall: Record<string, unknown>; published: unknown }> = {
  permission: {
    toolCall: { name: "write_file", kind: "edit" },
    published: { kind: "permission" },
  },
  command: {
    toolCall: { toolCallId: "run", kind: "execute", rawInput: { command: "bun test" } },
    published: { kind: "command", command: "bun test" },
  },
  "file-change": {
    toolCall: { toolCallId: "edit", kind: "edit", locations: [{ path: "/w/a.ts" }] },
    published: { kind: "file-change", paths: ["/w/a.ts"] },
  },
};

function park(kind: string, state: SessionState, child: AcpProcess) {
  const approval = APPROVAL_CALLS[kind];
  if (approval) {
    child.onPermission(7, {
      sessionId: state.acpSessionId,
      toolCall: approval.toolCall,
      options: [
        { optionId: "allow", kind: "allow_once" },
        { optionId: "reject", kind: "reject_once" },
      ],
    });
    expect(publicApprovals(state)).toEqual([expect.objectContaining(approval.published)]);
  } else {
    parkGrokInteraction(
      state,
      child,
      7,
      kind === "question" ? "x.ai/ask_user_question" : "x.ai/exit_plan_mode",
      {
        sessionId: state.acpSessionId,
        toolCallId: "held",
        planContent: "Plan",
        questions: [{ question: "Continue?", options: [{ label: "Yes" }] }],
      },
    );
  }
}

for (const kind of [...Object.keys(APPROVAL_CALLS), "question", "plan"]) {
  describe(`${kind} expiry`, () => {
    test("five minutes denies the request and reports the owning turn failure through dispatch", async () => {
      const f = fixture();
      try {
        await start(f.state, "A");
        expect(await outcome(f.state, "A")).toEqual({ dispatch: "dispatched" });
        jest.useFakeTimers();
        park(kind, f.state, f.child);
        jest.advanceTimersByTime(5 * 60_000 - 1);
        expect(f.responses).toEqual([]);
        jest.advanceTimersByTime(1);
        jest.useRealTimers();
        expect(f.responses).toEqual([
          // Cancelled, never the allow option, for every approval kind.
          kind in APPROVAL_CALLS ? { outcome: { outcome: "cancelled" } } : { outcome: "cancelled" },
        ]);
        expect(f.state.approvals.size + f.state.interactions.size).toBe(0);
        f.complete();
        expect(await finished(f.state, "A")).toEqual({
          dispatch: "dispatched",
          turn: {
            state: "completed",
            error: expect.stringMatching(/went unanswered for 5 minutes$/),
          },
        });
      } finally {
        jest.useRealTimers();
        clearApprovals(f.state);
        sessions.delete(f.state.id);
      }
    });

    test("a request left in turn A cannot fail turn B when it expires", async () => {
      const f = fixture();
      try {
        await start(f.state, "A");
        jest.useFakeTimers();
        park(kind, f.state, f.child);
        f.complete();
        expect(await finished(f.state, "A")).toEqual({
          dispatch: "dispatched",
          turn: { state: "completed" },
        });
        await start(f.state, "B");
        jest.advanceTimersByTime(5 * 60_000);
        jest.useRealTimers();
        expect(f.responses).toHaveLength(1);
        f.complete();
        expect(await finished(f.state, "B")).toEqual({
          dispatch: "dispatched",
          turn: { state: "completed" },
        });
        expect(await outcome(f.state, "A")).toEqual({
          dispatch: "dispatched",
          turn: { state: "completed" },
        });
      } finally {
        jest.useRealTimers();
        clearApprovals(f.state);
        sessions.delete(f.state.id);
      }
    });
  });
}
