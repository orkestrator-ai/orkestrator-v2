/**
 * The change signal (to-do 8102 task 2, D7), in process over the real router:
 *
 * - the revision harness: every mutation path the bridge's tests drive, with
 *   the state read as the backend gets it (`/status` + `/approvals` +
 *   `/interactions`, minus the combined `revision`) and the state revision
 *   peeked without reading. A path that changes the read without moving the
 *   revision fails. The transcript route is held to its own revision the same
 *   way;
 * - the conditional `/status` read (`knownStateRevision`);
 * - the observe stream's frames.
 */
import "./testing/unit-test-env.js";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  BRIDGE_KNOWN_STATE_REVISION_PARAM,
  isBridgeOpaqueRevision,
  isBridgeStateRevision,
  parseBridgeObservationFrame,
} from "@orkestrator/protocol/bridge-state-revision";
import { expectStateRevisionMoves } from "@orkestrator/protocol/node/bridge-state-revision";
import { RuntimeHealthRecorder } from "@orkestrator/protocol/runtime-health";
import {
  authToken,
  provider,
  sessions,
  type AcpProcess,
  type JsonObject,
  type SessionState,
} from "./acp-context.js";
import { configureCommandChanges } from "./acp-command-changes.js";
import { json, route } from "./acp-http.js";
import {
  applySessionUpdate,
  applyVendorUpdate,
  attachChild,
  clearApprovals,
  parkGrokElicitation,
  parkGrokInteraction,
  setSessionReadOnly,
} from "./acp-session.js";
import { acpTranscriptRevision, observationHub, stateRevisions } from "./acp-state-revision.js";
import { nativeFetch, NativeAbortController, waitFor } from "./acp-test-harness.js";
import { failTranscriptLimit } from "./acp-transcript.js";
import { normalizeAcpSessionConfig } from "./session-config.js";

const headers = { authorization: `Bearer ${authToken}`, "content-type": "application/json" };
const VENDOR_SESSION = "vendor-session";

let server: Server;
let base: string;

beforeAll(async () => {
  configureCommandChanges({ probe: null });
  server = createServer((request, response) => {
    void route(request, response, new AbortController().signal).catch((error: unknown) => {
      json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  observationHub.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const fixtures = new Set<SessionState>();
afterEach(() => {
  for (const state of fixtures) {
    clearApprovals(state);
    sessions.delete(state.id);
  }
  fixtures.clear();
});

interface Fixture {
  state: SessionState;
  child: AcpProcess;
  responses: Array<{ id: number; result: unknown }>;
  /** The open `session/prompt` requests, oldest first. */
  prompts: Array<{ resolve: (value: unknown) => void; reject: (error: unknown) => void }>;
}

function fixture(id: string): Fixture {
  const responses: Fixture["responses"] = [];
  const prompts: Fixture["prompts"] = [];
  const child = {
    request: (method: string) =>
      method === "session/prompt"
        ? new Promise((resolve, reject) => prompts.push({ resolve, reject }))
        : Promise.resolve({}),
    respond: (requestId: number, result: unknown) => responses.push({ id: requestId, result }),
    notify: () => undefined,
    close: async () => undefined,
    // Read by close: a stub that "exited" lets the close complete.
    child: { exitCode: 0, signalCode: null },
  } as unknown as AcpProcess;
  const state: SessionState = {
    id,
    acpSessionId: VENDOR_SESSION,
    status: "idle",
    messages: [],
    activeSubagentToolIds: new Set(),
    activeSubagentDescriptors: new Map(),
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
    sessionConfig: normalizeAcpSessionConfig(provider, {
      sessionId: VENDOR_SESSION,
      modes: {
        currentModeId: "build",
        availableModes: [
          { id: "build", name: "Build" },
          { id: "plan", name: "Plan" },
        ],
      },
    }),
    dispatching: false,
    historyReplay: false,
    health: new RuntimeHealthRecorder(),
  };
  attachChild(state, child);
  sessions.set(state.id, state);
  fixtures.add(state);
  return { state, child, responses, prompts };
}

async function get(path: string): Promise<Response> {
  return nativeFetch(`${base}${path}`, { headers });
}

async function post(path: string, body: unknown = {}): Promise<Response> {
  return nativeFetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

/**
 * Exactly what the backend's state read gets for an ACP session, minus the
 * combined `revision` (the transcript's, see `acp-state-revision.ts`) and the
 * `stateRevision` stamp itself.
 */
async function stateRead(state: SessionState): Promise<unknown> {
  const status = await get(`/session/${state.id}/status`);
  if (status.status === 404) return { missing: true };
  expect(status.status).toBe(200);
  const {
    revision: _revision,
    stateRevision: _stateRevision,
    ...body
  } = (await status.json()) as JsonObject;
  const approvals = (await get(`/session/${state.id}/approvals`).then((r) => r.json())) as {
    approvals: unknown[];
  };
  const interactions = (await get(`/session/${state.id}/interactions`).then((r) => r.json())) as {
    interactions: unknown[];
  };
  return { body, approvals: approvals.approvals, interactions: interactions.interactions };
}

async function transcriptRead(state: SessionState): Promise<unknown> {
  const response = await get(`/session/${state.id}/transcript`);
  if (response.status === 404) return { missing: true };
  return response.json();
}

type Expectation = "state" | "transcript" | "either";

/**
 * One mutation, held to both revisions: the state read against the state
 * revision, the transcript route against the transcript revision. `expected`
 * names which read the mutation must actually change, so a step that silently
 * stopped exercising anything fails too.
 */
async function step(
  state: SessionState,
  label: string,
  expected: Expectation,
  mutate: () => unknown,
): Promise<void> {
  let stateResult!: { changed: boolean; moved: boolean };
  const transcriptResult = await expectStateRevisionMoves({
    label: `${label} (transcript)`,
    read: () => transcriptRead(state),
    peek: () => acpTranscriptRevision(state),
    mutate: async () => {
      stateResult = await expectStateRevisionMoves({
        label,
        read: () => stateRead(state),
        peek: () => stateRevisions.peek(state.id),
        mutate,
      });
    },
  });
  if (expected === "state")
    expect({ label, changed: stateResult.changed }).toEqual({ label, changed: true });
  if (expected === "transcript") {
    expect({ label, changed: transcriptResult.changed }).toEqual({ label, changed: true });
  }
  if (expected === "either") {
    expect({ label, changed: stateResult.changed || transcriptResult.changed }).toEqual({
      label,
      changed: true,
    });
  }
}

const promptBody = (requestId: string) => ({ prompt: "hello", requestId });

async function settled(state: SessionState, requestId: string): Promise<void> {
  await waitFor(
    async () =>
      (await get(`/session/${state.id}/dispatch?requestId=${requestId}`).then((r) => r.json())) as {
        turn?: unknown;
      },
    (body) => body.turn !== undefined,
  );
}

describe("state revision harness", () => {
  test("every mutation path that changes the state read moves the state revision", async () => {
    const f = fixture("revision-harness");
    const { state, child } = f;
    const send = (update: JsonObject) =>
      applySessionUpdate(state, { sessionId: VENDOR_SESSION, update });

    await step(state, "prompt start", "state", async () => {
      expect((await post(`/session/${state.id}/prompt`, promptBody("r1"))).status).toBe(202);
    });
    await step(state, "agent text chunk", "transcript", () =>
      send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }),
    );
    await step(state, "agent thought chunk", "transcript", () =>
      send({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } }),
    );
    await step(state, "tool call", "transcript", () =>
      send({
        sessionUpdate: "tool_call",
        toolCallId: "run",
        title: "Run tests",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "bun test" },
      }),
    );
    await step(state, "tool call update", "transcript", () =>
      send({ sessionUpdate: "tool_call_update", toolCallId: "run", status: "completed" }),
    );
    await step(state, "plan", "transcript", () =>
      send({
        sessionUpdate: "plan",
        entries: [{ content: "Write it", status: "in_progress", priority: "medium" }],
      }),
    );
    await step(state, "usage update", "state", () =>
      send({ sessionUpdate: "usage_update", used: 120, size: 2_000 }),
    );
    await step(state, "provider notice", "state", () =>
      send({ sessionUpdate: "notice", title: "Heads up", severity: "warning" }),
    );
    await step(state, "unknown update kind", "state", () =>
      send({ sessionUpdate: "brand_new_kind" }),
    );

    await step(state, "permission parked", "state", () =>
      child.onPermission(7, {
        sessionId: VENDOR_SESSION,
        toolCall: { toolCallId: "run", kind: "execute", rawInput: { command: "bun test" } },
        options: [
          { optionId: "allow", kind: "allow_once" },
          { optionId: "reject", kind: "reject_once" },
        ],
      }),
    );
    const [approval] = [...state.approvals.keys()];
    await step(state, "permission held", "state", async () => {
      const held = await post(
        `/session/${state.id}/approvals/${encodeURIComponent(approval!)}/hold`,
        { held: true },
      );
      expect(held.status).toBe(200);
    });
    await step(state, "permission answered", "state", async () => {
      const answered = await post(
        `/session/${state.id}/approvals/${encodeURIComponent(approval!)}`,
        { decision: "approve" },
      );
      expect(answered.status).toBe(200);
    });

    await step(state, "question parked", "state", () =>
      parkGrokInteraction(state, child, 8, "x.ai/ask_user_question", {
        sessionId: VENDOR_SESSION,
        toolCallId: "question",
        questions: [{ question: "Continue?", options: [{ label: "Yes" }] }],
      }),
    );
    await step(state, "question held", "state", async () => {
      expect(
        (await post(`/session/${state.id}/interactions/question/hold`, { held: true })).status,
      ).toBe(200);
    });
    await step(state, "question answered", "state", async () => {
      expect(
        (await post(`/session/${state.id}/interactions/question`, { action: "cancel" })).status,
      ).toBe(200);
    });

    await step(state, "plan approval parked", "state", () =>
      parkGrokInteraction(state, child, 9, "x.ai/exit_plan_mode", {
        sessionId: VENDOR_SESSION,
        toolCallId: "plan-approval",
        planContent: "The plan",
      }),
    );
    await step(state, "MCP form parked", "state", () =>
      parkGrokElicitation(state, child, 10, {
        sessionId: VENDOR_SESSION,
        toolCallId: "form",
        serverName: "probe",
        message: "Name?",
        mode: "form",
        requestedSchema: { type: "object", properties: { name: { type: "string" } } },
      }),
    );
    await step(state, "MCP form withdrawn", "state", () =>
      applyVendorUpdate(state, "_x.ai/session_notification", {
        sessionId: VENDOR_SESSION,
        update: { sessionUpdate: "interaction_resolved", tool_call_id: "form" },
      }),
    );
    await step(state, "uncollectable MCP link declined", "state", () =>
      parkGrokElicitation(state, child, 11, {
        sessionId: VENDOR_SESSION,
        toolCallId: "link",
        serverName: "probe",
        message: "Open this",
        mode: "url",
        url: "ftp://example.com/",
      }),
    );
    await step(state, "cancel denies parked requests", "state", async () => {
      expect((await post(`/session/${state.id}/cancel`)).status).toBe(202);
    });

    await step(state, "prompt finish", "state", async () => {
      f.prompts.shift()!.resolve({ stopReason: "end_turn" });
      await settled(state, "r1");
    });

    await step(state, "title", "state", () =>
      send({ sessionUpdate: "session_info_update", title: "Named session" }),
    );
    await step(state, "title cleared", "state", () =>
      send({ sessionUpdate: "session_info_update", title: null }),
    );
    await step(state, "config option update", "state", () =>
      send({
        sessionUpdate: "config_option_update",
        configOptions: [
          {
            id: "effort",
            category: "thought_level",
            type: "select",
            currentValue: "high",
            options: [
              { value: "low", name: "Low" },
              { value: "high", name: "High" },
            ],
          },
        ],
      }),
    );
    await step(state, "mode update", "state", () =>
      send({ sessionUpdate: "current_mode_update", currentModeId: "plan" }),
    );
    await step(state, "commands update", "state", () =>
      send({
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "review", description: "Review the change" }],
      }),
    );
    await step(state, "vendor model catalogue", "either", () =>
      applyVendorUpdate(state, "cursor/models/update", {
        sessionId: VENDOR_SESSION,
        availableModels: [{ modelId: "model-a", name: "Model A" }],
        currentModelId: "model-a",
      }),
    );
    await step(state, "config route", "state", async () => {
      expect((await post(`/session/${state.id}/config`, { mode: "build" })).status).toBe(200);
    });

    await step(state, "prompt error", "state", async () => {
      expect((await post(`/session/${state.id}/prompt`, promptBody("r2"))).status).toBe(202);
      f.prompts.shift()!.reject(new Error("agent failed"));
      await settled(state, "r2");
    });
    await step(state, "transcript limit", "state", () => {
      state.status = "running";
      failTranscriptLimit(state);
    });
    await step(state, "read-only", "state", () => setSessionReadOnly(state, true));
    attachChild(state, child);
    await step(state, "agent exit", "state", () => child.onClose(new Error("agent exited")));
    await step(state, "close", "state", async () => {
      expect((await post(`/session/${state.id}/close`)).status).toBe(200);
    });
  });

  test("a mutation that skips the helpers fails the harness", async () => {
    const { state } = fixture("revision-harness-negative");
    await expect(
      expectStateRevisionMoves({
        label: "silent error",
        read: () => stateRead(state),
        peek: () => stateRevisions.peek(state.id),
        mutate: () => {
          state.error = "set without a bump";
        },
      }),
    ).rejects.toThrow(/silent error: the state read changed but its revision did not move/);
  });
});

describe("conditional status read", () => {
  test("a current knownStateRevision answers unchanged until a mutation", async () => {
    const { state } = fixture("conditional-status");
    const first = (await get(`/session/${state.id}/status`).then((r) => r.json())) as JsonObject;
    expect(isBridgeStateRevision(first.stateRevision)).toBe(true);
    const known = first.stateRevision as string;
    const conditional = (path: string) =>
      get(`${path}?${BRIDGE_KNOWN_STATE_REVISION_PARAM}=${encodeURIComponent(known)}`).then((r) =>
        r.json(),
      );

    expect(await conditional(`/session/${state.id}/status`)).toEqual({
      unchanged: true,
      stateRevision: known,
    });

    // A transcript-only change leaves the state read alone.
    applySessionUpdate(state, {
      sessionId: VENDOR_SESSION,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } },
    });
    expect(await conditional(`/session/${state.id}/status`)).toEqual({
      unchanged: true,
      stateRevision: known,
    });

    applySessionUpdate(state, {
      sessionId: VENDOR_SESSION,
      update: { sessionUpdate: "session_info_update", title: "Renamed" },
    });
    const full = (await conditional(`/session/${state.id}/status`)) as JsonObject;
    expect(full.unchanged).toBeUndefined();
    expect(full.title).toBe("Renamed");
    expect(isBridgeStateRevision(full.stateRevision)).toBe(true);
    expect(full.stateRevision).not.toBe(known);

    // A malformed or foreign revision is never `unchanged`.
    const foreign = (await get(
      `/session/${state.id}/status?${BRIDGE_KNOWN_STATE_REVISION_PARAM}=other:1`,
    ).then((r) => r.json())) as JsonObject;
    expect(foreign.composer).toBeDefined();
  });

  test("without the query the body is today's plus stateRevision", async () => {
    const { state } = fixture("plain-status");
    const body = (await get(`/session/${state.id}/status`).then((r) => r.json())) as JsonObject;
    expect(Object.keys(body).sort()).toEqual(
      ["status", "revision", "composer", "resumableSessionId", "runtime", "stateRevision"].sort(),
    );
    expect(body).toMatchObject({
      status: "idle",
      revision: state.revision,
      composer: JSON.parse(JSON.stringify(state.sessionConfig.composer)),
    });
  });

  test("a state change the helpers missed is still caught on read", async () => {
    const { state } = fixture("settle-backstop");
    const first = (await get(`/session/${state.id}/status`).then((r) => r.json())) as JsonObject;
    state.error = "set without a bump";
    const second = (await get(
      `/session/${state.id}/status?${BRIDGE_KNOWN_STATE_REVISION_PARAM}=${first.stateRevision as string}`,
    ).then((r) => r.json())) as JsonObject;
    expect(second.error).toBe("set without a bump");
    expect(second.stateRevision).not.toBe(first.stateRevision);
  });
});

describe("observe stream", () => {
  interface Frame {
    event: string;
    id?: string;
    data: string;
  }

  async function subscribe(path: string) {
    const controller = new NativeAbortController();
    const response = await nativeFetch(`${base}${path}`, {
      headers,
      signal: controller.signal,
    });
    const frames: Frame[] = [];
    if (response.status === 200) {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      void (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) return;
            buffer += decoder.decode(value, { stream: true });
            let end: number;
            while ((end = buffer.indexOf("\n\n")) >= 0) {
              const raw = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              const frame: Frame = { event: "message", data: "" };
              for (const line of raw.split("\n")) {
                if (line.startsWith("event: ")) frame.event = line.slice(7);
                else if (line.startsWith("id: ")) frame.id = line.slice(4);
                else if (line.startsWith("data: ")) frame.data += line.slice(6);
              }
              frames.push(frame);
            }
          }
        } catch {
          // Aborted at the end of the test.
        }
      })();
    }
    return { response, frames, close: () => controller.abort() };
  }

  test("requires observe=1 and the bridge token", async () => {
    const unauthenticated = await nativeFetch(`${base}/event/subscribe?observe=1`);
    expect(unauthenticated.status).toBe(401);
    const plain = await get("/event/subscribe");
    expect(plain.status).toBe(400);
  });

  test("a change publishes a frame naming the session and its moved revisions", async () => {
    const { state } = fixture("observe-frames");
    const before = (await get(`/session/${state.id}/status`).then((r) => r.json())) as JsonObject;
    const transcriptBefore = acpTranscriptRevision(state);
    const stream = await subscribe("/event/subscribe?observe=1");
    try {
      expect(stream.response.status).toBe(200);
      await waitFor(
        async () => stream.frames,
        (frames) => frames.some((frame) => frame.event === "connected"),
      );
      const connected = JSON.parse(stream.frames[0]!.data) as JsonObject;
      expect(connected).toMatchObject({ observe: true, revisions: 1 });

      // A state change moves the state revision...
      applySessionUpdate(state, {
        sessionId: VENDOR_SESSION,
        update: { sessionUpdate: "session_info_update", title: "Observed" },
      });
      const stateFrame = await waitFor(
        async () => stream.frames.filter((frame) => frame.event === "session.changed"),
        (frames) => frames.length >= 1,
      );
      const parsedState = parseBridgeObservationFrame(stateFrame[0]!.data);
      expect(parsedState.sessionId).toBe(state.id);
      expect(isBridgeStateRevision(parsedState.stateRevision)).toBe(true);
      expect(parsedState.stateRevision).not.toBe(before.stateRevision);
      expect(isBridgeOpaqueRevision(parsedState.transcriptRevision)).toBe(true);
      expect(parsedState.transcriptRevision).not.toBe(transcriptBefore);

      // ...a transcript chunk only the transcript revision.
      applySessionUpdate(state, {
        sessionId: VENDOR_SESSION,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } },
      });
      const frames = await waitFor(
        async () => stream.frames.filter((frame) => frame.event === "session.changed"),
        (all) => all.length >= 2,
      );
      const parsedTranscript = parseBridgeObservationFrame(frames[1]!.data);
      expect(parsedTranscript.sessionId).toBe(state.id);
      expect(parsedTranscript.stateRevision).toBe(parsedState.stateRevision);
      expect(parsedTranscript.transcriptRevision).not.toBe(parsedState.transcriptRevision);
      expect(parsedTranscript.transcriptRevision).toBe(acpTranscriptRevision(state));
    } finally {
      stream.close();
    }
  });
});
