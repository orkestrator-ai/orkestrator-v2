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

  test("archived IDs on later pages stay out even when the rollout remains under sessions", async () => {
    writeRollout("sessions", "thread-later-archived");
    const h = await harness({
      "thread/list": (params) => {
        if (params.archived !== true) return { data: [], nextCursor: null };
        return params.cursor === "archived-page-2"
          ? { data: [threadPayload("thread-later-archived")], nextCursor: null }
          : { data: [], nextCursor: "archived-page-2" };
      },
    });
    expect((await h.runtime.listSessions()).sessions.map((session) => session.id)).not.toContain(
      "thread-later-archived",
    );
    expect(
      h
        .child()
        .requests.filter((request) => request.method === "thread/list")
        .map((request) => request.params),
    ).toEqual([
      expect.not.objectContaining({ archived: true }),
      expect.objectContaining({ archived: true }),
      expect.objectContaining({ archived: true, cursor: "archived-page-2" }),
    ]);
  });

  test("archived conversations are listed last and flagged, only when asked for", async () => {
    writeRollout("sessions", "thread-live");
    writeRollout("sessions", "thread-listed-archived");
    writeRollout("archived_sessions", "thread-moved");
    const h = await harness({
      "thread/list": (params) =>
        params.archived === true
          ? { data: [threadPayload("thread-listed-archived")], nextCursor: null }
          : { data: [], nextCursor: null },
    });
    const { sessions } = await h.runtime.listSessions({ includeArchived: true });
    expect(sessions[0]).toMatchObject({ id: "thread-live" });
    expect(sessions[0]!.archived).toBeUndefined();
    expect(
      sessions
        .slice(1)
        .map((session) => [session.id, session.archived])
        .sort(),
    ).toEqual([
      ["thread-listed-archived", true],
      ["thread-moved", true],
    ]);
  });

  test.each([512, 513])(
    "bounds serialized history while retaining archives beside %s live rows",
    async (liveCount) => {
      const longTitle = "x".repeat(1_024);
      const h = await harness({
        "thread/list": (params) => ({
          data: Array.from(
            { length: params.archived === true ? 2_000 : liveCount },
            (_, index) => ({
              ...threadPayload(`${params.archived === true ? "archived" : "live"}-${index}`),
              name: index % 2 === 0 ? longTitle : null,
              preview: longTitle,
            }),
          ),
          nextCursor: null,
        }),
      });
      const result = await h.runtime.listSessions({ includeArchived: true });
      expect(result.sessions.filter((entry) => !entry.archived)).toHaveLength(512);
      expect(result.sessions.filter((entry) => entry.archived)).toHaveLength(512);
      expect(result.sessions[512]).toMatchObject({ id: "archived-0", archived: true });
      expect(result.sessions.every((entry) => (entry.title?.length ?? 0) <= 512)).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(2 * 1024 * 1024);
      expect((await h.runtime.listSessions()).sessions.every((entry) => !entry.archived)).toBe(
        true,
      );
    },
  );

  test("byte budgets include JSON escaping and preserve space for each category", async () => {
    const h = await harness({
      "thread/list": (params) => ({
        data: Array.from({ length: 512 }, (_, index) => ({
          ...threadPayload(`${params.archived === true ? "archived" : "live"}-${index}`),
          name: "\u0000".repeat(512),
        })),
        nextCursor: null,
      }),
    });
    const result = await h.runtime.listSessions({ includeArchived: true });
    const live = result.sessions.filter((entry) => !entry.archived);
    const archived = result.sessions.filter((entry) => entry.archived);
    expect(live.length).toBeGreaterThan(0);
    expect(archived.length).toBeGreaterThan(0);
    expect(live.length).toBeLessThan(512);
    expect(archived.length).toBeLessThan(512);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(2 * 1024 * 1024);
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
