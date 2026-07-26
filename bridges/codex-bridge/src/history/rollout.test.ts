import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  clearTranscriptPathCache,
  getTranscriptPathCacheStats,
  setTranscriptPathCacheLimitsForTesting,
  createSharedTranscriptMetaLoader,
  extractPersistedMessageText,
  findTranscriptPath,
  getPersistedSessionMeta,
  getSessionMetaFromTranscriptPath,
  hydrateMessagesFromPersistedSession,
  mergePersistedSessionMeta,
  readTranscriptLines,
} from "./rollout.js";

const temporaryDirectories: string[] = [];

async function temporaryRollout(threadId: string, lines: unknown[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rollout-test-"));
  temporaryDirectories.push(root);
  const path = join(root, "sessions", `${threadId}.jsonl`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  return path;
}

afterEach(async () => {
  clearTranscriptPathCache();
  setTranscriptPathCacheLimitsForTesting();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("rollout public helpers", () => {
  test("finds supplied transcript paths without scanning global state", async () => {
    expect(await findTranscriptPath("thread-2", ["/a/thread-1.jsonl", "/b/thread-2.jsonl"]))
      .toBe("/b/thread-2.jsonl");
    expect(await findTranscriptPath("missing", ["/a/thread-1.jsonl"])).toBeNull();
  });

  test("an explicit array snapshot is never cached", async () => {
    expect(await findTranscriptPath("thread-9", ["/a/thread-9.jsonl"])).toBe("/a/thread-9.jsonl");
    // The caller may have scoped or filtered that listing, so it must not
    // become the answer for a later unscoped lookup.
    expect(getTranscriptPathCacheStats().entries).toBe(0);
  });
});

describe("findTranscriptPath path cache", () => {
  test("serves a still-present path from cache instead of walking again", async () => {
    const path = await temporaryRollout("thread-cached", [{ type: "session_meta" }]);
    let walks = 0;
    const listPaths = async () => {
      walks += 1;
      return [path];
    };

    expect(await findTranscriptPath("thread-cached", listPaths)).toBe(path);
    expect(await findTranscriptPath("thread-cached", listPaths)).toBe(path);
    expect(walks).toBe(1);
  });

  test("re-walks once a cached rollout no longer exists on disk", async () => {
    const path = await temporaryRollout("thread-vanishing", [{ type: "session_meta" }]);
    const replacement = await temporaryRollout("thread-vanishing", [{ type: "session_meta" }]);
    let walks = 0;
    const listPaths = async () => {
      walks += 1;
      return walks === 1 ? [path] : [replacement];
    };

    expect(await findTranscriptPath("thread-vanishing", listPaths)).toBe(path);
    await rm(path);
    // The stat revalidation fails, so the stale entry is dropped rather than
    // pinning a path that would fail every later read.
    expect(await findTranscriptPath("thread-vanishing", listPaths)).toBe(replacement);
    expect(walks).toBe(2);
  });

  test("a negative result is cached only for its short TTL", async () => {
    let walks = 0;
    const listPaths = async () => {
      walks += 1;
      return [] as readonly string[];
    };

    expect(await findTranscriptPath("thread-missing", listPaths)).toBeNull();
    expect(await findTranscriptPath("thread-missing", listPaths)).toBeNull();
    expect(walks).toBe(1);

    // A freshly spawned thread's rollout appears moments after the miss, so the
    // negative entry must expire rather than pin "no transcript" for the session.
    setTranscriptPathCacheLimitsForTesting({ negativeTtlMs: 0 });
    expect(await findTranscriptPath("thread-missing", listPaths)).toBeNull();
    expect(walks).toBe(2);
  });

  test("evicts least-recently-used entries past the cap", async () => {
    setTranscriptPathCacheLimitsForTesting({ maxEntries: 2 });
    const listPaths = async () => [] as readonly string[];

    await findTranscriptPath("thread-a", listPaths);
    await findTranscriptPath("thread-b", listPaths);
    await findTranscriptPath("thread-c", listPaths);

    expect(getTranscriptPathCacheStats().entries).toBe(2);
  });

  test("reading a missing session index yields no lines rather than throwing", async () => {
    const root = await mkdtemp(join(tmpdir(), "rollout-test-"));
    temporaryDirectories.push(root);
    // The session index is absent in a fresh Codex home; callers treat that as
    // "no persisted sessions", so it must not propagate as an error.
    expect(await readTranscriptLines(join(root, "session_index.jsonl"))).toEqual([]);
    expect(await readTranscriptLines(root)).toEqual([]);
  });

  test("clearTranscriptPathCache forces the next lookup to walk", async () => {
    let walks = 0;
    const listPaths = async () => {
      walks += 1;
      return [] as readonly string[];
    };

    await findTranscriptPath("thread-cleared", listPaths);
    clearTranscriptPathCache();
    await findTranscriptPath("thread-cleared", listPaths);
    expect(walks).toBe(2);
  });
});

describe("rollout public helpers (continued)", () => {

  test("reads JSONL lines and extracts defensive metadata", async () => {
    const path = await temporaryRollout("thread-1", [
      {
        type: "session_meta",
        payload: {
          id: "thread-1",
          cwd: "/workspace",
          timestamp: "2026-07-25T12:00:00.000Z",
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Fix the bridge" }],
        },
      },
    ]);

    expect(await readTranscriptLines(path)).toHaveLength(2);
    expect(await getSessionMetaFromTranscriptPath(path)).toMatchObject({
      id: "thread-1",
      cwd: "/workspace",
      title: "Fix the bridge",
      titleSource: "prompt",
      transcriptPath: path,
    });
  });

  test("invalid transcript metadata falls back without fabricating a session", async () => {
    const noMeta = await temporaryRollout("no-meta", [{ type: "response_item" }]);
    expect(await getSessionMetaFromTranscriptPath(noMeta)).toBeNull();

    const malformedId = await temporaryRollout("bad-id", [{
      type: "session_meta",
      payload: { id: "", timestamp: 4 },
    }]);
    expect(await getSessionMetaFromTranscriptPath(malformedId)).toBeNull();
    expect(
      await getPersistedSessionMeta(
        "missing",
        "Fallback",
        "2026-07-25T12:00:00.000Z",
        undefined,
        [],
      ),
    ).toEqual({
      id: "missing",
      title: "Fallback",
      titleSource: "codex",
      updatedAt: "2026-07-25T12:00:00.000Z",
    });
  });

  test("shared metadata loader scans lazily, once, and reuses the same path snapshot", async () => {
    let scans = 0;
    const seen: Array<{ id: string; paths: readonly string[] }> = [];
    const loader = createSharedTranscriptMetaLoader(
      async () => {
        scans += 1;
        return ["/one.jsonl"];
      },
      async (id, paths) => {
        seen.push({ id, paths: await paths() });
        return null;
      },
    );
    await Promise.all([loader("a"), loader("b")]);
    expect(scans).toBe(1);
    expect(seen.map((entry) => entry.id).sort()).toEqual(["a", "b"]);
    expect(seen[0]!.paths).toBe(seen[1]!.paths);
  });

  test("shared metadata loader never walks when metadata resolves without paths", async () => {
    let scans = 0;
    const loader = createSharedTranscriptMetaLoader(
      async () => {
        scans += 1;
        return [];
      },
      async (id) => ({ id, updatedAt: "2026-07-25T12:00:00.000Z" }),
    );
    await Promise.all([loader("a"), loader("b")]);
    expect(scans).toBe(0);
  });

  test("metadata merge inserts copies and advances only the timestamp", () => {
    const sessions = new Map();
    const original = {
      id: "thread-1",
      title: "Indexed title",
      updatedAt: "2026-07-25T10:00:00.000Z",
    };
    mergePersistedSessionMeta(sessions, original);
    original.title = "mutated";
    mergePersistedSessionMeta(sessions, {
      id: "thread-1",
      title: "Transcript title",
      updatedAt: "2026-07-25T12:00:00.000Z",
    });
    expect(sessions.get("thread-1")).toEqual({
      id: "thread-1",
      title: "Indexed title",
      updatedAt: "2026-07-25T12:00:00.000Z",
    });
  });

  test("extracts multipart text and filters synthetic injected user context", () => {
    expect(
      extractPersistedMessageText([
        { type: "output_text", text: "one" },
        null,
        { type: "output_text", text: "two" },
      ], "assistant"),
    ).toBe("one\ntwo");
    expect(extractPersistedMessageText("bad", "assistant")).toBeNull();
    expect(extractPersistedMessageText([{ type: "input_text", text: "  " }], "user"))
      .toBeNull();
    expect(
      extractPersistedMessageText(
        [{ type: "input_text", text: "# AGENTS.md instructions for /workspace" }],
        "user",
      ),
    ).toBeNull();
    expect(
      extractPersistedMessageText(
        [{
          type: "input_text",
          text: "<recommended_plugins>\nHere is a list of plugins that are available but not installed.",
        }],
        "user",
      ),
    ).toBeNull();
  });

  test("hydrates one rollout defensively while skipping malformed and synthetic records", async () => {
    const root = await mkdtemp(join(tmpdir(), "rollout-hydration-"));
    temporaryDirectories.push(root);
    const path = join(root, "sessions", "2026", "07", "thread-hydrate.jsonl");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      [
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "thread-hydrate",
            cwd: "/workspace",
            timestamp: "2026-07-25T12:00:00.000Z",
          },
        }),
        "{malformed",
        JSON.stringify({
          timestamp: "2026-07-25T12:01:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "# AGENTS.md instructions for /workspace" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-25T12:02:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "real prompt" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-25T12:03:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "real answer" }],
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: { type: "message", role: "system", content: [] },
        }),
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(root, "session_index.jsonl"),
      `${JSON.stringify({
        id: "thread-hydrate",
        updated_at: "2026-07-25T12:03:00.000Z",
      })}\n`,
      "utf8",
    );

    const previousHome = process.env.CODEX_HOME;
    const previousCwd = process.env.CWD;
    process.env.CODEX_HOME = root;
    process.env.CWD = "/workspace";
    try {
      const hydrated = await hydrateMessagesFromPersistedSession("thread-hydrate");
      expect(hydrated.messages.map((message) => ({
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
      }))).toEqual([
        {
          role: "user",
          content: "real prompt",
          createdAt: "2026-07-25T12:02:00.000Z",
        },
        {
          role: "assistant",
          content: "real answer",
          createdAt: "2026-07-25T12:03:00.000Z",
        },
      ]);
      expect(hydrated.title).toBe("real prompt");
    } finally {
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
      if (previousCwd === undefined) delete process.env.CWD;
      else process.env.CWD = previousCwd;
    }
  });
});
