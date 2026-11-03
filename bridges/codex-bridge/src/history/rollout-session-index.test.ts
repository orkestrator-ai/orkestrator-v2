import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearTranscriptPathCache,
  hydrateMessagesFromPersistedSession,
  invalidateTranscriptCatalogCache,
  listPersistedSessionsForCwd,
} from "./rollout.js";
import { clearSessionIndexCache, getSessionIndexCacheStats } from "./session-index-cache.js";
import { clearTranscriptCache } from "../transcript-cache.js";

/**
 * Hydration and the cwd listing read Codex's `session_index.jsonl` through the
 * parsed-index cache (BR-11): an unchanged index is not read again, and an
 * appended rename costs one read of the appended bytes.
 */

let root = "";
let previousHome: string | undefined;
let previousCwd: string | undefined;

function indexLine(id: string, fields: { thread_name?: string; updated_at?: string }): string {
  return `${JSON.stringify({ id, ...fields })}\n`;
}

async function writeRollout(threadId: string): Promise<void> {
  const path = join(root, "sessions", `${threadId}.jsonl`);
  await mkdir(join(root, "sessions"), { recursive: true });
  await writeFile(
    path,
    `${[
      {
        type: "session_meta",
        payload: { id: threadId, cwd: "/workspace", timestamp: "2026-11-03T09:00:00.000Z" },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Prompt title" }],
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n")}\n`,
    "utf8",
  );
}

function indexReads() {
  const { fullReads, tailReads, uncachedReads } = getSessionIndexCacheStats();
  return { fullReads, tailReads, uncachedReads };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rollout-session-index-"));
  previousHome = process.env.CODEX_HOME;
  previousCwd = process.env.CWD;
  process.env.CODEX_HOME = root;
  process.env.CWD = "/workspace";
  clearSessionIndexCache();
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousHome;
  if (previousCwd === undefined) delete process.env.CWD;
  else process.env.CWD = previousCwd;
  clearSessionIndexCache();
  clearTranscriptPathCache();
  clearTranscriptCache();
  invalidateTranscriptCatalogCache();
  await rm(root, { recursive: true, force: true });
});

describe("session index reads on hydrate", () => {
  test("two hydrates of an unchanged index read it once", async () => {
    await writeRollout("thread-a");
    await writeFile(
      join(root, "session_index.jsonl"),
      indexLine("thread-a", { thread_name: "Indexed", updated_at: "2026-11-03T09:00:00.000Z" }),
      "utf8",
    );

    expect((await hydrateMessagesFromPersistedSession("thread-a")).title).toBe("Indexed");
    expect((await hydrateMessagesFromPersistedSession("thread-a")).title).toBe("Indexed");
    expect(indexReads()).toEqual({ fullReads: 1, tailReads: 0, uncachedReads: 0 });
  });

  test("a rename appended between hydrates is found after one tail read", async () => {
    await writeRollout("thread-a");
    const indexPath = join(root, "session_index.jsonl");
    await writeFile(indexPath, indexLine("thread-a", { thread_name: "Before" }), "utf8");
    expect((await hydrateMessagesFromPersistedSession("thread-a")).title).toBe("Before");

    await appendFile(indexPath, indexLine("thread-a", { thread_name: "After" }), "utf8");
    const hydrated = await hydrateMessagesFromPersistedSession("thread-a");

    expect(hydrated.title).toBe("After");
    expect(hydrated.titleSource).toBe("codex");
    expect(indexReads()).toEqual({ fullReads: 1, tailReads: 1, uncachedReads: 0 });
  });

  test("a shorter rewritten index is read again in full", async () => {
    await writeRollout("thread-a");
    const indexPath = join(root, "session_index.jsonl");
    await writeFile(
      indexPath,
      indexLine("thread-other", { thread_name: "Padding padding padding padding" }) +
        indexLine("thread-a", { thread_name: "Long original name" }),
      "utf8",
    );
    expect((await hydrateMessagesFromPersistedSession("thread-a")).title).toBe(
      "Long original name",
    );

    await writeFile(indexPath, indexLine("thread-a", { thread_name: "Short" }), "utf8");
    expect((await hydrateMessagesFromPersistedSession("thread-a")).title).toBe("Short");
    expect(indexReads()).toEqual({ fullReads: 2, tailReads: 0, uncachedReads: 0 });
  });
});

describe("session index reads in the cwd listing", () => {
  test("the listing reads the index through the same cache", async () => {
    await writeRollout("thread-a");
    const indexPath = join(root, "session_index.jsonl");
    await writeFile(
      indexPath,
      indexLine("thread-a", { thread_name: "First", updated_at: "2026-11-03T09:00:00.000Z" }),
      "utf8",
    );
    expect(
      (await listPersistedSessionsForCwd("/workspace")).map((session) => session.title),
    ).toEqual(["First"]);

    await appendFile(
      indexPath,
      indexLine("thread-a", { thread_name: "Renamed", updated_at: "2026-11-03T10:00:00.000Z" }),
      "utf8",
    );
    invalidateTranscriptCatalogCache();
    expect(
      (await listPersistedSessionsForCwd("/workspace")).map((session) => session.title),
    ).toEqual(["Renamed"]);
    // A hydrate after the listing reuses what the listing parsed.
    expect((await hydrateMessagesFromPersistedSession("thread-a")).title).toBe("Renamed");
    expect(indexReads()).toEqual({ fullReads: 1, tailReads: 1, uncachedReads: 0 });
  });
});
