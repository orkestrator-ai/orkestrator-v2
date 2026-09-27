/**
 * The v2 lightweight transcript contract over the real session manager:
 * `GET /session/:id/transcript?version=2`, `/transcript/detail` and
 * `/transcript/page`. Authentication is the composition root's global
 * middleware and is asserted in `index-auth.test.ts`.
 */
import {
  createSession,
  getSession,
  materializePersistedSession,
  mockSdkGetSessionMessages,
  track,
} from "./session-manager-test-harness.js";
import { describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { Hono } from "hono";
import { markTranscriptChanged, resetTranscriptEpoch } from "./transcript-revision.js";
import sessionRoutes from "../routes/session.js";
import { compressTranscriptReads } from "../routes/session-transcript.js";
import type { NormalizedMessage, NormalizedPart, SessionState } from "../types/index.js";

/*
 * Mounted the way the composition root mounts it, including the detail/page
 * compression it registers. Importing the real root here would load modules
 * the harness mocks for later suites in the same process.
 */
const app = new Hono();
compressTranscriptReads(app);
app.route("/session", sessionRoutes);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any;

const createdAt = "2026-09-27T00:00:00.000Z";

function textMessage(id: string, content = `message ${id}`): NormalizedMessage {
  return { id, role: "assistant", content, parts: [{ type: "text", content }], createdAt };
}

function toolMessage(id: string, output: string): NormalizedMessage {
  const part: NormalizedPart = {
    type: "tool-invocation",
    content: "Read file",
    toolName: "Read",
    toolUseId: `${id}-tool`,
    toolState: "success",
    toolOutput: output,
  };
  return { id, role: "assistant", content: "", parts: [part], createdAt };
}

function sessionWith(messages: NormalizedMessage[]): SessionState {
  const created = createSession("Fixed title");
  track(created.id);
  const session = getSession(created.id)!;
  session.messages.push(...messages);
  markTranscriptChanged(session);
  return session;
}

async function get(path: string, init?: RequestInit): Promise<Response> {
  return app.request(path, init);
}

async function read(path: string): Promise<Body> {
  const response = await get(path);
  expect(response.status).toBe(200);
  return response.json();
}

function transcriptPath(id: string, params: Record<string, string> = {}): string {
  return `/session/${encodeURIComponent(id)}/transcript?${new URLSearchParams(params)}`;
}

function detailPath(id: string, locator: string): string {
  return `/session/${encodeURIComponent(id)}/transcript/detail?${new URLSearchParams({ locator })}`;
}

function pagePath(id: string, params: Record<string, string>): string {
  return `/session/${encodeURIComponent(id)}/transcript/page?${new URLSearchParams(params)}`;
}

const bigOutput = "tool output line\n".repeat(20_000);

describe("GET /session/:id/transcript?version=2", () => {
  test("summarizes a large tool output so an earlier message keeps its place", async () => {
    const session = sessionWith([textMessage("earlier"), toolMessage("tool", bigOutput)]);
    const window = { limit: "100", targetBytes: String(128 * 1024) };

    const v1 = await read(transcriptPath(session.id, window));
    expect(v1.version).toBe(1);
    // The raw output alone overflows the window, so v1 drops what came before.
    expect(v1.value.messages.map((m: NormalizedMessage) => m.id)).not.toContain("earlier");

    const v2 = await read(transcriptPath(session.id, { ...window, version: "2" }));
    expect(v2).toMatchObject({
      version: 2,
      status: "snapshot",
      value: {
        startIndex: 0,
        complete: true,
        freshness: "current",
        title: "Fixed title",
        revision: v1.value.revision,
        contentEpoch: v1.value.contentEpoch,
        generation: v1.value.generation,
        capabilities: { details: true, pages: true },
      },
    });
    expect(v2.value.messages.map((m: NormalizedMessage) => m.id)).toEqual(["earlier", "tool"]);
    const summarized = v2.value.messages[1].parts[0];
    expect(summarized.toolOutput).toBeUndefined();
    expect(summarized.detail.fields).toEqual(["toolOutput"]);
    expect(summarized.detail.bytes).toBeGreaterThan(4 * 1024);
    expect(v2.value.historyCursor).toBeUndefined();
    expect(v2.token).not.toBe(v1.token);
  });

  test("answers unchanged for its own token, and never for a v1 token", async () => {
    const session = sessionWith([textMessage("a"), toolMessage("b", bigOutput)]);
    const first = await read(transcriptPath(session.id, { version: "2" }));
    expect(
      await read(transcriptPath(session.id, { version: "2", knownToken: first.token })),
    ).toEqual({ version: 2, status: "unchanged", token: first.token });
    const v1 = await read(transcriptPath(session.id));
    expect(v1.version).toBe(1);
    expect(
      (await read(transcriptPath(session.id, { version: "2", knownToken: v1.token }))).status,
    ).toBe("snapshot");
    // The v1 route still answers its own token unchanged, exactly as before.
    expect(await read(transcriptPath(session.id, { knownToken: v1.token }))).toEqual({
      version: 1,
      status: "unchanged",
      token: v1.token,
    });
  });

  test("an unchanged v2 read of a 1,000-row session visits no message", async () => {
    const session = sessionWith(
      Array.from({ length: 1_000 }, (_, index) => textMessage(`m${index}`)),
    );
    let visits = 0;
    for (const message of session.messages) {
      Object.defineProperty(message, "toJSON", {
        enumerable: false,
        value(this: NormalizedMessage) {
          visits += 1;
          return { ...this };
        },
      });
    }
    const first = await read(transcriptPath(session.id, { version: "2" }));
    expect(visits).toBeLessThanOrEqual(3 * 100);
    visits = 0;
    const unchanged = await read(
      transcriptPath(session.id, { version: "2", knownToken: first.token }),
    );
    expect(unchanged.status).toBe("unchanged");
    expect(visits).toBe(0);
  });
});

describe("GET /session/:id/transcript/detail", () => {
  async function locatorFor(session: SessionState): Promise<string> {
    const v2 = await read(transcriptPath(session.id, { version: "2" }));
    return v2.value.messages.at(-1).parts[0].detail.locator;
  }

  test("serves the exact body, then expired once the part changed", async () => {
    const session = sessionWith([toolMessage("tool", bigOutput)]);
    const locator = await locatorFor(session);
    const detail = await read(detailPath(session.id, locator));
    expect(detail).toMatchObject({ version: 1, status: "ok", detail: { toolOutput: bigOutput } });
    expect(detail.bytes).toBe(Buffer.byteLength(JSON.stringify({ toolOutput: bigOutput })));

    session.messages[0]!.parts[0]!.toolOutput = `${bigOutput}more`;
    markTranscriptChanged(session);
    expect(await read(detailPath(session.id, locator))).toEqual({ version: 1, status: "expired" });
  });

  test("a message that is no longer retained is missing", async () => {
    const session = sessionWith([textMessage("keep"), toolMessage("tool", bigOutput)]);
    const locator = await locatorFor(session);
    session.messages.pop();
    markTranscriptChanged(session);
    expect(await read(detailPath(session.id, locator))).toEqual({ version: 1, status: "missing" });
  });

  test("a malformed or absent locator is invalid", async () => {
    const session = sessionWith([toolMessage("tool", bigOutput)]);
    expect(await read(detailPath(session.id, "not-a-locator"))).toEqual({
      version: 1,
      status: "invalid",
    });
    expect(await read(`/session/${session.id}/transcript/detail`)).toEqual({
      version: 1,
      status: "invalid",
    });
  });

  test("compresses a large detail when the client accepts gzip", async () => {
    const session = sessionWith([toolMessage("tool", bigOutput)]);
    const locator = await locatorFor(session);
    // Set on the built request: the DOM test preload drops it from an init.
    const request = new Request(`http://localhost${detailPath(session.id, locator)}`);
    request.headers.set("Accept-Encoding", "gzip");
    const response = await app.request(request);
    expect(response.headers.get("Content-Encoding")).toBe("gzip");
    expect(response.headers.get("Vary")).toContain("Accept-Encoding");
    const decoded = JSON.parse(gunzipSync(Buffer.from(await response.arrayBuffer())).toString());
    expect(decoded.detail.toolOutput).toBe(bigOutput);
  });
});

describe("GET /session/:id/transcript/page", () => {
  test("walks from the history cursor to the start with advancing cursors", async () => {
    const session = sessionWith(
      Array.from({ length: 250 }, (_, index) => textMessage(`m${index}`)),
    );
    const v2 = await read(transcriptPath(session.id, { version: "2" }));
    expect(v2.value.startIndex).toBe(150);
    const ids: string[] = v2.value.messages.map((m: NormalizedMessage) => m.id);
    let cursor: string | undefined = v2.value.historyCursor;
    const starts: number[] = [];
    while (cursor) {
      const page = await read(pagePath(session.id, { cursor, limit: "100" }));
      expect(page.status).toBe("page");
      expect(page.contentEpoch).toBe(v2.value.contentEpoch);
      expect(page.nextCursor).not.toBe(cursor);
      starts.push(page.startIndex);
      ids.unshift(...page.messages.map((m: NormalizedMessage) => m.id));
      if (!page.nextCursor) expect(page).toMatchObject({ startIndex: 0, complete: true });
      cursor = page.nextCursor;
    }
    expect(starts).toEqual([50, 0]);
    expect(ids).toEqual(Array.from({ length: 250 }, (_, index) => `m${index}`));
  });

  test("a cursor from a previous content epoch has expired", async () => {
    const session = sessionWith(
      Array.from({ length: 150 }, (_, index) => textMessage(`m${index}`)),
    );
    const v2 = await read(transcriptPath(session.id, { version: "2" }));
    resetTranscriptEpoch(session);
    expect(await read(pagePath(session.id, { cursor: v2.value.historyCursor }))).toEqual({
      version: 1,
      status: "expired",
    });
    expect(await read(pagePath(session.id, { cursor: "garbage" }))).toEqual({
      version: 1,
      status: "invalid",
    });
  });

  test("detail and page never hydrate a preview", async () => {
    const state = await materializePersistedSession();
    expect(state.persistedMessagesLoaded).toBe(false);
    mockSdkGetSessionMessages.mockClear();
    expect((await read(pagePath(state.id, { cursor: "garbage" }))).status).toBe("invalid");
    expect((await read(detailPath(state.id, "garbage"))).status).toBe("invalid");
    expect(state.persistedMessagesLoaded).toBe(false);
    expect(mockSdkGetSessionMessages).not.toHaveBeenCalled();
  });
});

describe("unknown sessions", () => {
  test("detail and page answer in band; the summary route keeps its 404", async () => {
    const detail = await get(detailPath("session-unknown", "bd1.x"));
    expect(detail.status).toBe(200);
    expect(await detail.json()).toEqual({ version: 1, status: "missing" });
    const page = await get(pagePath("session-unknown", { cursor: "bp1.x" }));
    expect(page.status).toBe(200);
    expect(await page.json()).toEqual({ version: 1, status: "expired" });
    expect((await get(transcriptPath("session-unknown", { version: "2" }))).status).toBe(404);
    // An unknown sub-path is still not a route.
    expect((await get("/session/session-unknown/transcript/other")).status).toBe(404);
  });
});
