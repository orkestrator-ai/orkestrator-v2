import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
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

  test("shared metadata loader scans once and reuses the same path snapshot", async () => {
    let scans = 0;
    const seen: Array<{ id: string; paths: readonly string[] }> = [];
    const loader = createSharedTranscriptMetaLoader(
      async () => {
        scans += 1;
        return ["/one.jsonl"];
      },
      async (id, paths) => {
        seen.push({ id, paths });
        return null;
      },
    );
    await Promise.all([loader("a"), loader("b")]);
    expect(scans).toBe(1);
    expect(seen.map((entry) => entry.id).sort()).toEqual(["a", "b"]);
    expect(seen[0]!.paths).toBe(seen[1]!.paths);
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
