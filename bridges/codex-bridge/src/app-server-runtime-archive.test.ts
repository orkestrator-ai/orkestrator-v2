import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codexHome, harness, threadPayload } from "./app-server-runtime-test-harness.js";
import { clearTranscriptPathCache, invalidateTranscriptCatalogCache } from "./history/rollout.js";
import { clearTranscriptCache } from "./transcript-cache.js";

// The listing caches are process-wide; leave none pointing into this test's home.
afterEach(() => {
  invalidateTranscriptCatalogCache();
  clearTranscriptPathCache();
  clearTranscriptCache();
});

/** A rollout the fallback parser lists for the harness workspace. */
function writeRollout(directory: "sessions" | "archived_sessions", threadId: string): void {
  const root = join(codexHome, directory, "2026", "10", "27");
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, `rollout-2026-10-27T00-00-00-${threadId}.jsonl`),
    `${JSON.stringify({
      type: "session_meta",
      payload: { id: threadId, cwd: "/tmp/ws", timestamp: "2026-10-27T00:00:00.000Z" },
    })}\n${JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    })}\n`,
  );
}

describe("Codex archive", () => {
  test("archives through thread/archive, never thread/delete", async () => {
    const h = await harness({ "thread/archive": () => ({}), "thread/unarchive": () => ({}) });
    expect(await h.runtime.setResumableArchived("thread-old", true)).toBe("archived");
    expect(await h.runtime.setResumableArchived("thread-old", false)).toBe("unarchived");
    const methods = h.child().requests.map((request) => request.method);
    expect(methods).toContain("thread/archive");
    expect(methods).toContain("thread/unarchive");
    expect(methods).not.toContain("thread/delete");
    expect(
      h.child().requests.find((request) => request.method === "thread/archive")?.params,
    ).toEqual({ threadId: "thread-old" });
  });

  test("refuses a conversation a tab here still holds", async () => {
    const h = await harness({ "thread/archive": () => ({}) });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    h.runtime.getRegistry().getSession(sessionId)!.threadId = "thread-open";
    expect(await h.runtime.setResumableArchived("thread-open", true)).toBe("in-use");
    expect(h.child().requests.some((request) => request.method === "thread/archive")).toBe(false);
  });

  test("reports a refused archive as failed", async () => {
    const h = await harness({
      "thread/archive": () => {
        throw new Error("no such thread");
      },
    });
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      expect(await h.runtime.setResumableArchived("thread-gone", true)).toBe("failed");
    } finally {
      console.warn = warn;
    }
  });

  test("the resume list leaves archived conversations out", async () => {
    writeRollout("sessions", "thread-live");
    writeRollout("sessions", "thread-listed-archived");
    writeRollout("archived_sessions", "thread-moved");
    const h = await harness({
      "thread/list": (params) =>
        params.archived === true
          ? { data: [threadPayload("thread-listed-archived")], nextCursor: null }
          : { data: [], nextCursor: null },
    });
    const ids = (await h.runtime.listSessions()).sessions.map((session) => session.id);
    expect(ids).toContain("thread-live");
    expect(ids).not.toContain("thread-listed-archived");
    expect(ids).not.toContain("thread-moved");
  });
});
