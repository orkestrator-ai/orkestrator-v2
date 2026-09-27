/**
 * The v2 lightweight transcript contract over the real Cursor router:
 * `GET /session/:id/transcript?version=2`, `/transcript/detail` and
 * `/transcript/page`, all read from one transcript source.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  bridgeTranscriptContract,
  type BridgeTranscriptContractAdapter,
  type ContractMessage,
  type ContractReader,
} from "@orkestrator/protocol/bridge-transcript-contract";
import { authToken } from "./config.js";
import { drainPersistence, loadPersistedState, schedulePersist } from "./persistence.js";
import {
  clientSessionKeys,
  sessions,
  type BridgeMessage,
  type BridgeToolPart,
  type SessionState,
} from "./state.js";
import { startRouterHarness, type RouterHarness } from "./testing/router-harness.js";
import { rewindTranscriptTo } from "./transcript.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any;

let harness: RouterHarness;
/** Routers started by a simulated restart, closed with the harness. */
const restartedServers: Server[] = [];

beforeEach(async () => {
  harness = await startRouterHarness();
});

afterEach(async () => {
  for (const server of restartedServers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await harness.close();
});

const createdAt = "2026-09-27T00:00:00.000Z";
const bigOutput = "tool output line\n".repeat(20_000);

function textMessage(id: string): BridgeMessage {
  return {
    id,
    role: "assistant",
    content: `message ${id}`,
    parts: [
      { type: "text", content: `message ${id}`, sourcePartId: `${id}:0`, sourceMessageId: id },
    ],
    createdAt,
  };
}

function toolMessage(id: string, output: string): BridgeMessage {
  return {
    id,
    role: "assistant",
    content: "",
    parts: [
      {
        type: "tool-invocation",
        content: "Read file",
        sourcePartId: `${id}:tool`,
        sourceMessageId: id,
        toolUseId: `${id}-call`,
        toolName: "read",
        toolState: "success",
        toolOutput: output,
      },
    ],
    createdAt,
  };
}

async function sessionWith(messages: BridgeMessage[]): Promise<SessionState> {
  const state = await harness.createSession();
  state.messages.push(...messages);
  state.revision += 1;
  return state;
}

async function read(path: string): Promise<Body> {
  const response = await harness.call(path);
  expect(response.status).toBe(200);
  return response.json();
}

const transcript = (state: SessionState, params: Record<string, string> = {}) =>
  `/session/${state.id}/transcript?${new URLSearchParams(params)}`;
const detail = (id: string, locator: string) =>
  `/session/${id}/transcript/detail?${new URLSearchParams({ locator })}`;
const page = (id: string, params: Record<string, string>) =>
  `/session/${id}/transcript/page?${new URLSearchParams(params)}`;

describe("Cursor v2 transcript summaries", () => {
  test("summarizes a large output so an earlier message keeps its place", async () => {
    const state = await sessionWith([textMessage("earlier"), toolMessage("tool", bigOutput)]);
    const window = { limit: "100", targetBytes: String(128 * 1024) };
    const v1 = await read(transcript(state, window));
    expect(v1.version).toBe(1);
    expect(v1.value.messages.map((m: BridgeMessage) => m.id)).not.toContain("earlier");

    const v2 = await read(transcript(state, { ...window, version: "2" }));
    expect(v2).toMatchObject({
      version: 2,
      status: "snapshot",
      value: {
        startIndex: 0,
        complete: true,
        generation: v1.value.generation,
        contentEpoch: v1.value.contentEpoch,
        revision: v1.value.revision,
        capabilities: { details: true, pages: true },
      },
    });
    expect(v2.value.messages.map((m: BridgeMessage) => m.id)).toEqual(["earlier", "tool"]);
    expect(v2.value.messages[1].parts[0].toolOutput).toBeUndefined();
    expect(v2.value.messages[1].parts[0].detail.fields).toEqual(["toolOutput"]);
  });

  test("answers unchanged for its own token; v1 keeps its own", async () => {
    const state = await sessionWith([toolMessage("tool", bigOutput)]);
    const first = await read(transcript(state, { version: "2" }));
    expect(await read(transcript(state, { version: "2", knownToken: first.token }))).toEqual({
      version: 2,
      status: "unchanged",
      token: first.token,
    });
    const v1 = await read(transcript(state));
    expect(await read(transcript(state, { knownToken: v1.token }))).toEqual({
      version: 1,
      status: "unchanged",
      token: v1.token,
    });
    expect((await read(transcript(state, { version: "2", knownToken: v1.token }))).status).toBe(
      "snapshot",
    );
  });
});

describe("Cursor transcript details", () => {
  test("serves the exact body, then expired, missing and invalid", async () => {
    const state = await sessionWith([textMessage("keep"), toolMessage("tool", bigOutput)]);
    const v2 = await read(transcript(state, { version: "2" }));
    const locator = v2.value.messages[1].parts[0].detail.locator as string;
    expect(await read(detail(state.id, locator))).toMatchObject({
      version: 1,
      status: "ok",
      detail: { toolOutput: bigOutput },
    });

    (state.messages[1]!.parts[0] as { toolOutput?: string }).toolOutput = `${bigOutput}more`;
    state.revision += 1;
    expect(await read(detail(state.id, locator))).toEqual({ version: 1, status: "expired" });

    state.messages.pop();
    state.revision += 1;
    expect(await read(detail(state.id, locator))).toEqual({ version: 1, status: "missing" });
    expect(await read(detail(state.id, "not-a-locator"))).toEqual({
      version: 1,
      status: "invalid",
    });
  });

  test("a detail read is user activity, like the transcript read", async () => {
    const state = await sessionWith([toolMessage("tool", bigOutput)]);
    state.lastAccessed = 0;
    await read(detail(state.id, "not-a-locator"));
    expect(state.lastAccessed).toBeGreaterThan(0);
    state.lastAccessed = 0;
    await read(page(state.id, { cursor: "garbage" }));
    expect(state.lastAccessed).toBeGreaterThan(0);
  });
});

describe("Cursor transcript pages", () => {
  test("walks from the history cursor to the start with advancing cursors", async () => {
    const state = await sessionWith(
      Array.from({ length: 250 }, (_, index) => textMessage(`m${index}`)),
    );
    const v2 = await read(transcript(state, { version: "2" }));
    expect(v2.value.startIndex).toBe(150);
    const ids: string[] = v2.value.messages.map((m: BridgeMessage) => m.id);
    const starts: number[] = [];
    let cursor: string | undefined = v2.value.historyCursor;
    while (cursor) {
      const next = await read(page(state.id, { cursor, limit: "100" }));
      expect(next).toMatchObject({ version: 1, status: "page" });
      expect(next.contentEpoch).toBe(v2.value.contentEpoch);
      expect(next.nextCursor).not.toBe(cursor);
      starts.push(next.startIndex);
      ids.unshift(...next.messages.map((m: BridgeMessage) => m.id));
      cursor = next.nextCursor;
    }
    expect(starts).toEqual([50, 0]);
    expect(ids).toEqual(Array.from({ length: 250 }, (_, index) => `m${index}`));
  });

  test("a cursor from before a front trim has expired", async () => {
    const state = await sessionWith(
      Array.from({ length: 150 }, (_, index) => textMessage(`m${index}`)),
    );
    const v2 = await read(transcript(state, { version: "2" }));
    state.messages.splice(0, 10);
    state.droppedMessages += 10;
    state.revision += 1;
    expect(await read(page(state.id, { cursor: v2.value.historyCursor }))).toEqual({
      version: 1,
      status: "expired",
    });
    expect(await read(page(state.id, { cursor: "garbage" }))).toEqual({
      version: 1,
      status: "invalid",
    });
  });
});

describe("Cursor transcript routes for an unknown session", () => {
  test("detail and page answer in band; the summary route keeps its 404", async () => {
    const missingDetail = await harness.call(detail("unknown", "bd1.x"));
    expect(missingDetail.status).toBe(200);
    expect(await missingDetail.json()).toEqual({ version: 1, status: "missing" });
    const missingPage = await harness.call(page("unknown", { cursor: "bp1.x" }));
    expect(missingPage.status).toBe(200);
    expect(await missingPage.json()).toEqual({ version: 1, status: "expired" });
    expect((await harness.call("/session/unknown/transcript?version=2")).status).toBe(404);
  });

  test("the new routes require the bridge token", async () => {
    const response = await harness.call(page("unknown", { cursor: "bp1.x" }), {
      headers: { authorization: "Bearer wrong" },
    });
    expect(response.status).toBe(401);
  });
});

/** Reads through a router, requiring the 200 every transcript route answers here. */
function reader(call: (path: string) => Promise<Response>): ContractReader {
  return async (path) => {
    const response = await call(path);
    expect(response.status).toBe(200);
    return response.json();
  };
}

let restarts = 0;

/**
 * The contract over the real Cursor router and state.
 *
 * A restart publishes the state file, forgets every in-memory session, loads
 * the file through the production restore path and serves it from a freshly
 * evaluated `http.ts` — a new module instance, so a new process generation —
 * over the same session registry.
 */
function cursorContractAdapter(): BridgeTranscriptContractAdapter<SessionState> {
  const toBridge = (message: ContractMessage) => structuredClone(message) as BridgeMessage;
  return {
    read: reader((path) => harness.call(path)),
    async seed(messages) {
      return sessionWith(messages.map(toBridge));
    },
    append(state, message) {
      state.messages.push(toBridge(message));
      state.revision += 1;
    },
    setToolOutput(state, messageId, output) {
      const message = state.messages.find((candidate) => candidate.id === messageId)!;
      (message.parts[0] as BridgeToolPart).toolOutput = output;
      state.revision += 1;
    },
    rewrite(state) {
      // The transcript step of a destructive rewind to an earlier turn.
      rewindTranscriptTo(state, state.messages[200]!.id);
    },
    async restart(state) {
      schedulePersist();
      await drainPersistence();
      sessions.clear();
      clientSessionKeys.clear();
      await loadPersistedState();
      restarts += 1;
      const specifier = `./http.js?contract-restart=${restarts}`;
      const fresh = (await import(specifier)) as typeof import("./http.js");
      const server = createServer((request, response) => {
        void fresh.route(request, response, new AbortController().signal);
      });
      restartedServers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const restored = sessions.get(state.id);
      if (!restored) throw new Error("the restart did not restore the session");
      return {
        read: reader((path) =>
          Bun.fetch(`${origin}${path}`, { headers: { authorization: `Bearer ${authToken}` } }),
        ),
        session: restored,
      };
    },
  };
}

describe("Cursor: shared v2 transcript contract", () => {
  for (const scenario of bridgeTranscriptContract) {
    test(scenario.name, async () => {
      await scenario.run(cursorContractAdapter());
    });
  }
});
