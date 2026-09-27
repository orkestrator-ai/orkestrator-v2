/**
 * The v2 lightweight transcript contract over the real ACP router, in process:
 * `GET /session/:id/transcript?version=2`, `/transcript/detail` and
 * `/transcript/page`, all read from one transcript source. Sessions are seeded
 * directly; these routes never reach the agent process.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
// Must precede every bridge import below: `acp-context.ts` resolves its
// provider configuration at module scope.
import "./testing/unit-test-env.js";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { route } from "./acp-http.js";
import { authToken, sessions, type BridgeMessage, type SessionState } from "./acp-context.js";
import { nativeFetch } from "./acp-test-harness.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any;

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    void route(request, response, new AbortController().signal);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const seeded: string[] = [];
afterEach(() => {
  for (const id of seeded.splice(0)) sessions.delete(id);
});

async function call(path: string, token: string = authToken): Promise<Response> {
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
    parts: [{ type: "text", content: `message ${id}` }],
    createdAt,
  } as BridgeMessage;
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
        toolUseId: `${id}-call`,
        toolName: "read",
        toolState: "success",
        toolOutput: output,
      },
    ],
    createdAt,
  } as BridgeMessage;
}

let nextId = 0;

/** Only the fields the transcript routes read; nothing here reaches an agent. */
function sessionWith(messages: BridgeMessage[]): SessionState {
  nextId += 1;
  const state = {
    id: `transcript-v2-${nextId}`,
    status: "idle",
    messages: [...messages],
    droppedMessages: 0,
    transcriptTruncated: false,
    uncheckedTranscriptBytes: 0,
    revision: 1,
  } as unknown as SessionState;
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

describe("ACP v2 transcript summaries", () => {
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
        generation: v1.value.generation,
        contentEpoch: 0,
        revision: 1,
        capabilities: { details: true, pages: true },
      },
    });
    expect(v2.value.generation).toStartWith("cursor:");
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
    expect(await read(transcript(state, { knownToken: v1.token }))).toEqual({
      version: 1,
      status: "unchanged",
      token: v1.token,
    });
  });
});

describe("ACP transcript details", () => {
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
});

describe("ACP transcript pages", () => {
  test("walks from the history cursor to the start with advancing cursors", async () => {
    const state = sessionWith(Array.from({ length: 250 }, (_, index) => textMessage(`m${index}`)));
    const v2 = await read(transcript(state, { version: "2" }));
    expect(v2.value.startIndex).toBe(150);
    const ids: string[] = v2.value.messages.map((m: BridgeMessage) => m.id);
    const starts: number[] = [];
    let cursor: string | undefined = v2.value.historyCursor;
    while (cursor) {
      const next = await read(page(state.id, { cursor, limit: "100" }));
      expect(next).toMatchObject({ version: 1, status: "page", contentEpoch: 0 });
      expect(next.nextCursor).not.toBe(cursor);
      starts.push(next.startIndex);
      ids.unshift(...next.messages.map((m: BridgeMessage) => m.id));
      cursor = next.nextCursor;
    }
    expect(starts).toEqual([50, 0]);
    expect(ids).toEqual(Array.from({ length: 250 }, (_, index) => `m${index}`));
  });

  test("a cursor from before a front trim has expired", async () => {
    const state = sessionWith(Array.from({ length: 150 }, (_, index) => textMessage(`m${index}`)));
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

describe("ACP transcript routes for an unknown session", () => {
  test("detail and page answer in band; the summary route keeps its 404", async () => {
    const missingDetail = await call(detail("unknown", "bd1.x"));
    expect(missingDetail.status).toBe(200);
    expect(await missingDetail.json()).toEqual({ version: 1, status: "missing" });
    const missingPage = await call(page("unknown", { cursor: "bp1.x" }));
    expect(missingPage.status).toBe(200);
    expect(await missingPage.json()).toEqual({ version: 1, status: "expired" });
    expect((await call("/session/unknown/transcript?version=2")).status).toBe(404);
    // An unknown sub-path is still not a route, as before.
    expect((await call("/session/unknown/transcript/other")).status).toBe(404);
  });

  test("the new routes require the bridge token", async () => {
    expect((await call(page("unknown", { cursor: "bp1.x" }), "wrong")).status).toBe(401);
    expect((await call(detail("unknown", "bd1.x"), "wrong")).status).toBe(401);
  });
});
