/** The resume-list archive routes, through the real router and a fake SDK. */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { useCursorAgentForTests } from "./agent-session.js";
import { authToken } from "./config.js";
import { route } from "./http.js";
import { sessions, type SessionState } from "./state.js";

let server: Server;
let baseUrl: string;
let restoreAgent: () => void;
const archive = mock(async (_agentId: string) => undefined);
const unarchive = mock(async (_agentId: string) => undefined);

// The test preload's browser-like `fetch` applies CORS to loopback requests.
const nativeFetch = Bun.fetch;
const post = (path: string, token: string | null = authToken ?? null) =>
  nativeFetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

beforeEach(async () => {
  sessions.clear();
  archive.mockClear();
  unarchive.mockClear();
  restoreAgent = useCursorAgentForTests({ archive, unarchive } as never);
  server = createServer((request, response) => {
    void route(request, response, new AbortController().signal);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterEach(async () => {
  restoreAgent();
  sessions.clear();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("archives and restores by the id the resume list gave", async () => {
  const archived = await post("/session/list/agent%2F1/archive");
  expect(archived.status).toBe(200);
  expect(await archived.json()).toEqual({ archived: true });
  expect(archive.mock.calls[0]?.[0]).toBe("agent/1");

  const restored = await post("/session/list/agent%2F1/unarchive");
  expect(restored.status).toBe(200);
  expect(await restored.json()).toEqual({ archived: false });
  expect(unarchive.mock.calls[0]?.[0]).toBe("agent/1");
});

test("refuses an agent a tab holds, without touching it", async () => {
  sessions.set("tab", { agentId: "agent-1" } as SessionState);
  const response = await post("/session/list/agent-1/archive");
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "This conversation is open in a tab" });
  expect(archive).not.toHaveBeenCalled();
});

test("reports an SDK failure and an unusable id without leaking either", async () => {
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    archive.mockImplementationOnce(async () => {
      throw new Error("Agent secret-detail not found");
    });
    const failed = await post("/session/list/agent-gone/archive");
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: "Cursor could not archive this conversation" });
  } finally {
    console.warn = warn;
  }
  expect((await post(`/session/list/${"a".repeat(257)}/archive`)).status).toBe(400);
  expect((await post("/session/list/bc-cloud/unarchive")).status).toBe(502);
  expect(unarchive).not.toHaveBeenCalled();
});

test("requires the bridge token", async () => {
  if (!authToken) return;
  expect((await post("/session/list/agent-1/archive", null)).status).toBe(401);
  expect(archive).not.toHaveBeenCalled();
});
