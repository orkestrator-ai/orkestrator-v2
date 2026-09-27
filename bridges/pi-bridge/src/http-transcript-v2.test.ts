/**
 * The v2 lightweight transcript contract over the real Pi router:
 * `GET /session/:id/transcript?version=2`, `/transcript/detail` and
 * `/transcript/page`, all read from one transcript source.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bridgeTranscriptContract,
  type BridgeTranscriptContractAdapter,
  type ContractMessage,
  type ContractReader,
} from "@orkestrator/protocol/bridge-transcript-contract";
import type { BridgeMessage, BridgeToolPart, SessionState } from "./state.js";

// `config.ts` reads its environment once, at import; load the router after.
process.env.PORT = "0";
process.env.HOSTNAME = "127.0.0.1";
process.env.PI_BRIDGE_TOKEN = "test-token";
process.env.PI_BRIDGE_LIBRARY_ONLY = "1";
delete process.env.PI_BRIDGE_STATE_DIR;

const { server, start, shutdown } = await import("./server.js");
const { authToken: TOKEN } = await import("./config.js");
const { newSessionState, resetRenderedHistory } = await import("./agent-session.js");
const { clientSessionKeys, sessions } = await import("./state.js");
const { loadPersistedState, persistBarrier } = await import("./persistence.js");
const { nativeFetch } = await import("./testing/native-fetch.js");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any;

let origin: string;

beforeAll(async () => {
  await start(0);
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await shutdown();
});

const seeded: string[] = [];
/** Routers started by a simulated restart. */
const restartedServers: Server[] = [];
afterEach(async () => {
  for (const id of seeded.splice(0)) sessions.delete(id);
  for (const restarted of restartedServers.splice(0)) {
    await new Promise<void>((resolve) => restarted.close(() => resolve()));
  }
});

async function call(path: string, token: string = TOKEN): Promise<Response> {
  return nativeFetch(`${origin}${path}`, { headers: { authorization: `Bearer ${token}` } });
}

async function read(path: string): Promise<Body> {
  const response = await call(path);
  expect(response.status).toBe(200);
  return response.json();
}

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

function sessionWith(messages: BridgeMessage[]): SessionState {
  const state = newSessionState();
  state.title = "Pi session";
  state.messages.push(...messages);
  state.revision += 1;
  sessions.set(state.id, state);
  seeded.push(state.id);
  return state;
}

const transcript = (state: SessionState, params: Record<string, string> = {}) =>
  `/session/${state.id}/transcript?${new URLSearchParams(params)}`;
const detail = (id: string, locator: string) =>
  `/session/${id}/transcript/detail?${new URLSearchParams({ locator })}`;
const page = (id: string, params: Record<string, string>) =>
  `/session/${id}/transcript/page?${new URLSearchParams(params)}`;

describe("Pi v2 transcript summaries", () => {
  test("summarizes a large output so an earlier message keeps its place", async () => {
    const state = sessionWith([textMessage("earlier"), toolMessage("tool", bigOutput)]);
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
        title: "Pi session",
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
    const state = sessionWith([toolMessage("tool", bigOutput)]);
    const first = await read(transcript(state, { version: "2" }));
    expect(await read(transcript(state, { version: "2", knownToken: first.token }))).toEqual({
      version: 2,
      status: "unchanged",
      token: first.token,
    });
    const v1 = await read(transcript(state));
    // A never-replaced session keeps its long-standing numeric epoch.
    expect(v1.value.contentEpoch).toBe(0);
    expect(await read(transcript(state, { knownToken: v1.token }))).toEqual({
      version: 1,
      status: "unchanged",
      token: v1.token,
    });
  });
});

describe("Pi transcript details", () => {
  test("serves the exact body, then expired, missing and invalid", async () => {
    const state = sessionWith([textMessage("keep"), toolMessage("tool", bigOutput)]);
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

  test("detail and page reads are user activity, like the transcript read", async () => {
    const state = sessionWith([toolMessage("tool", bigOutput)]);
    state.lastAccessed = 0;
    await read(detail(state.id, "not-a-locator"));
    expect(state.lastAccessed).toBeGreaterThan(0);
    state.lastAccessed = 0;
    await read(page(state.id, { cursor: "garbage" }));
    expect(state.lastAccessed).toBeGreaterThan(0);
  });
});

describe("Pi transcript pages", () => {
  test("walks from the history cursor to the start with advancing cursors", async () => {
    const state = sessionWith(Array.from({ length: 250 }, (_, index) => textMessage(`m${index}`)));
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

  test("a cursor from before a branch switch has expired", async () => {
    const state = sessionWith(Array.from({ length: 150 }, (_, index) => textMessage(`m${index}`)));
    const v2 = await read(transcript(state, { version: "2" }));
    // What branch navigation does: a different history from index 0, with
    // the same (zero) dropped count as before.
    state.messages = Array.from({ length: 150 }, (_, index) => textMessage(`other${index}`));
    state.transcriptEpoch = (state.transcriptEpoch ?? 0) + 1;
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

describe("Pi transcript routes for an unknown session", () => {
  test("detail and page answer in band; the summary route keeps its 404", async () => {
    const missingDetail = await call(detail("unknown", "bd1.x"));
    expect(missingDetail.status).toBe(200);
    expect(await missingDetail.json()).toEqual({ version: 1, status: "missing" });
    const missingPage = await call(page("unknown", { cursor: "bp1.x" }));
    expect(missingPage.status).toBe(200);
    expect(await missingPage.json()).toEqual({ version: 1, status: "expired" });
    expect((await call("/session/unknown/transcript?version=2")).status).toBe(404);
  });

  test("the new routes require the bridge token", async () => {
    expect((await call(page("unknown", { cursor: "bp1.x" }), "wrong")).status).toBe(401);
    expect((await call(detail("unknown", "bd1.x"), "wrong")).status).toBe(401);
  });
});

function reader(origin: string): ContractReader {
  return async (path) => {
    const response = await nativeFetch(`${origin}${path}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    return response.json();
  };
}

let restarts = 0;

/**
 * Publish every session to a private state file, forget them, and load that
 * file through the production restore path. The state directory is read per
 * call, so it exists only for the duration of the restart.
 */
async function republishAndRestore(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-transcript-contract-"));
  process.env.PI_BRIDGE_STATE_DIR = directory;
  try {
    await persistBarrier();
    sessions.clear();
    clientSessionKeys.clear();
    await loadPersistedState();
  } finally {
    delete process.env.PI_BRIDGE_STATE_DIR;
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * The contract over the real Pi router and state. A rewrite is branch
 * navigation's own reset followed by the re-render of an earlier branch; a
 * restart restores from the persisted state file and serves it from a freshly
 * evaluated `http.ts`, so a new process generation.
 */
function piContractAdapter(): BridgeTranscriptContractAdapter<SessionState> {
  const toBridge = (message: ContractMessage) => structuredClone(message) as BridgeMessage;
  return {
    read: reader(origin),
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
      // `navigateSessionHistory` to an earlier entry: reset, then render the
      // shorter branch from Pi's session file.
      const branch = state.messages.slice(0, 200);
      resetRenderedHistory(state);
      state.messages.push(...branch);
      state.revision += 1;
    },
    async restart(state) {
      await republishAndRestore();
      restarts += 1;
      const specifier = `./http.js?contract-restart=${restarts}`;
      const fresh = (await import(specifier)) as typeof import("./http.js");
      const restartedServer = createServer((request, response) => {
        void fresh.route(request, response, new AbortController().signal);
      });
      restartedServers.push(restartedServer);
      await new Promise<void>((resolve) => restartedServer.listen(0, "127.0.0.1", resolve));
      const restored = sessions.get(state.id);
      if (!restored) throw new Error("the restart did not restore the session");
      return {
        read: reader(`http://127.0.0.1:${(restartedServer.address() as AddressInfo).port}`),
        session: restored,
      };
    },
  };
}

describe("Pi: shared v2 transcript contract", () => {
  for (const scenario of bridgeTranscriptContract) {
    test(scenario.name, async () => {
      await scenario.run(piContractAdapter());
    });
  }
});
