/**
 * The v2 lightweight transcript contract over Codex's transcript routes:
 * `GET /session/:id/transcript?version=2`, `/transcript/detail` and
 * `/transcript/page`, all read from the bridge-owned display tail.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { CompressionStream as NodeCompressionStream } from "node:stream/web";
import { gunzipSync } from "node:zlib";
import { Hono } from "hono";
import type { NormalizedMessage } from "./messages/types.js";
import { registerCodexTranscriptRoutes, type CodexTranscriptRuntime } from "./transcript-routes.js";

// The DOM test preload replaces browser globals; Hono's compress middleware
// captures this constructor when it is installed.
const originalCompressionStream = globalThis.CompressionStream;
globalThis.CompressionStream = NodeCompressionStream as typeof CompressionStream;
afterAll(() => {
  globalThis.CompressionStream = originalCompressionStream;
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any;

const createdAt = "2026-09-27T00:00:00.000Z";
const bigOutput = "command output line\n".repeat(20_000);

function textMessage(id: string): NormalizedMessage {
  return { id, role: "assistant", content: `message ${id}`, parts: [], createdAt };
}

function toolMessage(id: string, output: string): NormalizedMessage {
  return {
    id,
    role: "assistant",
    content: "",
    parts: [
      {
        type: "tool-invocation",
        content: "Run command",
        toolName: "shell",
        toolUseId: `${id}-call`,
        toolState: "success",
        toolOutput: output,
      },
    ],
    createdAt,
  };
}

interface FakeSession {
  messages: NormalizedMessage[];
  freshness: "cached" | "current";
  complete: boolean;
  contentEpoch: number;
  messageRevision: number;
}

function harness(initial: Partial<FakeSession> = {}) {
  const session: FakeSession = {
    messages: [],
    freshness: "current",
    complete: true,
    contentEpoch: 1,
    messageRevision: 1,
    ...initial,
  };
  const touches: Array<boolean | undefined> = [];
  const runtime: CodexTranscriptRuntime = {
    getStatus: (sessionId, touch) => {
      touches.push(touch);
      return sessionId === "session-1"
        ? {
            title: "Codex session",
            engineGeneration: 3,
            contentEpoch: session.contentEpoch,
            messageRevision: session.messageRevision,
          }
        : null;
    },
    getCachedMessages: (sessionId) =>
      sessionId === "session-1"
        ? { messages: session.messages, freshness: session.freshness, complete: session.complete }
        : null,
  };
  const app = new Hono();
  registerCodexTranscriptRoutes(app, runtime);
  const read = async (path: string): Promise<Body> => {
    const response = await app.request(path);
    expect(response.status).toBe(200);
    return response.json();
  };
  return { app, session, touches, read };
}

const transcript = (params: Record<string, string> = {}) =>
  `/session/session-1/transcript?${new URLSearchParams(params)}`;
const detail = (locator: string, id = "session-1") =>
  `/session/${id}/transcript/detail?${new URLSearchParams({ locator })}`;
const page = (params: Record<string, string>, id = "session-1") =>
  `/session/${id}/transcript/page?${new URLSearchParams(params)}`;

describe("Codex v2 transcript summaries", () => {
  test("summarizes a large output so an earlier message keeps its place", async () => {
    const { read } = harness({
      messages: [textMessage("earlier"), toolMessage("tool", bigOutput)],
    });
    const window = { limit: "100", targetBytes: String(128 * 1024) };
    const v1 = await read(transcript(window));
    expect(v1.version).toBe(1);
    expect(v1.value.messages.map((m: NormalizedMessage) => m.id)).not.toContain("earlier");

    const v2 = await read(transcript({ ...window, version: "2" }));
    expect(v2).toMatchObject({
      version: 2,
      status: "snapshot",
      value: {
        startIndex: 0,
        complete: true,
        freshness: "current",
        generation: 3,
        contentEpoch: 1,
        revision: 1,
        title: "Codex session",
        capabilities: { details: true, pages: true },
      },
    });
    expect(v2.value.messages.map((m: NormalizedMessage) => m.id)).toEqual(["earlier", "tool"]);
    expect(v2.value.messages[1].parts[0].toolOutput).toBeUndefined();
    expect(v2.value.messages[1].parts[0].detail.fields).toEqual(["toolOutput"]);
  });

  test("answers unchanged for its own token without touching liveness", async () => {
    const { read, touches } = harness({ messages: [toolMessage("tool", bigOutput)] });
    const first = await read(transcript({ version: "2" }));
    expect(await read(transcript({ version: "2", knownToken: first.token }))).toEqual({
      version: 2,
      status: "unchanged",
      token: first.token,
    });
    const v1 = await read(transcript({}));
    expect(v1.version).toBe(1);
    expect(await read(transcript({ knownToken: v1.token }))).toEqual({
      version: 1,
      status: "unchanged",
      token: v1.token,
    });
    await read(detail("bd1.x"));
    await read(page({ cursor: "bp1.x" }));
    expect(touches.every((touch) => touch === false)).toBe(true);
  });
});

describe("Codex transcript details", () => {
  test("serves the exact body, then expired, missing and invalid", async () => {
    const { read, session } = harness({
      messages: [textMessage("keep"), toolMessage("tool", bigOutput)],
    });
    const v2 = await read(transcript({ version: "2" }));
    const locator = v2.value.messages[1].parts[0].detail.locator as string;
    expect(await read(detail(locator))).toMatchObject({
      version: 1,
      status: "ok",
      detail: { toolOutput: bigOutput },
    });

    session.messages[1]!.parts[0]!.toolOutput = `${bigOutput}more`;
    session.messageRevision += 1;
    expect(await read(detail(locator))).toEqual({ version: 1, status: "expired" });

    session.messages.pop();
    session.messageRevision += 1;
    expect(await read(detail(locator))).toEqual({ version: 1, status: "missing" });
    expect(await read(detail("not-a-locator"))).toEqual({ version: 1, status: "invalid" });
  });

  test("compresses a detail when the client accepts gzip", async () => {
    const { app, read } = harness({ messages: [toolMessage("tool", bigOutput)] });
    const v2 = await read(transcript({ version: "2" }));
    const request = new Request(
      `http://localhost${detail(v2.value.messages[0].parts[0].detail.locator)}`,
    );
    request.headers.set("Accept-Encoding", "gzip");
    const response = await app.request(request);
    expect(response.headers.get("Content-Encoding")).toBe("gzip");
    expect(response.headers.get("Vary")).toContain("Accept-Encoding");
    const decoded = JSON.parse(gunzipSync(Buffer.from(await response.arrayBuffer())).toString());
    expect(decoded.detail.toolOutput).toBe(bigOutput);
  });
});

describe("Codex transcript pages", () => {
  test("walks from the history cursor to the start with advancing cursors", async () => {
    const { read } = harness({
      messages: Array.from({ length: 250 }, (_, index) => textMessage(`m${index}`)),
    });
    const v2 = await read(transcript({ version: "2" }));
    expect(v2.value.startIndex).toBe(150);
    const ids: string[] = v2.value.messages.map((m: NormalizedMessage) => m.id);
    const starts: number[] = [];
    let cursor: string | undefined = v2.value.historyCursor;
    while (cursor) {
      const next = await read(page({ cursor, limit: "100" }));
      expect(next).toMatchObject({ version: 1, status: "page", generation: 3, contentEpoch: 1 });
      expect(next.nextCursor).not.toBe(cursor);
      starts.push(next.startIndex);
      ids.unshift(...next.messages.map((m: NormalizedMessage) => m.id));
      cursor = next.nextCursor;
    }
    expect(starts).toEqual([50, 0]);
    expect(ids).toEqual(Array.from({ length: 250 }, (_, index) => `m${index}`));
  });

  test("a cursor from before an epoch change has expired", async () => {
    const { read, session } = harness({
      messages: Array.from({ length: 150 }, (_, index) => textMessage(`m${index}`)),
      freshness: "cached",
      complete: false,
    });
    const preview = await read(transcript({ version: "2" }));
    expect(preview.value).toMatchObject({ freshness: "cached", complete: false });
    // Hydration (or a rewind, or a local-tail trim) starts a new epoch.
    session.contentEpoch += 1;
    session.freshness = "current";
    session.complete = true;
    expect(await read(page({ cursor: preview.value.historyCursor }))).toEqual({
      version: 1,
      status: "expired",
    });
    expect(await read(page({ cursor: "garbage" }))).toEqual({ version: 1, status: "invalid" });
  });
});

describe("Codex transcript routes for an unknown session", () => {
  test("detail and page answer in band; the summary route keeps its 404", async () => {
    const { app } = harness();
    const missingDetail = await app.request(detail("bd1.x", "unknown"));
    expect(missingDetail.status).toBe(200);
    expect(await missingDetail.json()).toEqual({ version: 1, status: "missing" });
    const missingPage = await app.request(page({ cursor: "bp1.x" }, "unknown"));
    expect(missingPage.status).toBe(200);
    expect(await missingPage.json()).toEqual({ version: 1, status: "expired" });
    const summary = await app.request("/session/unknown/transcript?version=2");
    expect(summary.status).toBe(404);
    expect((await app.request("/session/unknown/transcript/other")).status).toBe(404);
  });
});

describe("Codex composition root", () => {
  test("serves the new routes in band and under the bridge's authentication", async () => {
    process.env.CODEX_BRIDGE_NO_ENGINE = "1";
    process.env.CODEX_BRIDGE_NO_SERVER = "1";
    process.env.CODEX_BRIDGE_AUTH_DISABLED_FOR_TESTING = "1";
    const { app, __testing } = await import("./index.js");
    const missingDetail = await app.request(detail("bd1.x", "unknown"));
    expect(missingDetail.status).toBe(200);
    expect(await missingDetail.json()).toEqual({ version: 1, status: "missing" });
    const missingPage = await app.request(page({ cursor: "bp1.x" }, "unknown"));
    expect(missingPage.status).toBe(200);
    expect(await missingPage.json()).toEqual({ version: 1, status: "expired" });

    __testing.setBridgeAuthForTesting("route-token");
    try {
      expect((await app.request(detail("bd1.x", "unknown"))).status).toBe(401);
      expect((await app.request(page({ cursor: "bp1.x" }, "unknown"))).status).toBe(401);
    } finally {
      __testing.setBridgeAuthForTesting();
    }
  });
});
