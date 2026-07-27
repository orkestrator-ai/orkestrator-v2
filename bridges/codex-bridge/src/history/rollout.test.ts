import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildTranscriptCatalog,
  clearTranscriptPathCache,
  getTranscriptPathCacheStats,
  setTranscriptPathCacheLimitsForTesting,
  createSharedTranscriptMetaLoader,
  extractPersistedMessageText,
  findTranscriptPath,
  getPersistedSessionMeta,
  getSessionMetaFromTranscriptPath,
  hydrateMessagesFromPersistedSession,
  listPersistedSessionsForCwd,
  mergePersistedSessionMeta,
  readTranscriptLines,
} from "./rollout.js";
import { persistSessionTitle } from "../session-titles.js";
import {
  clearTranscriptCache,
  getTranscriptCacheStats,
} from "../transcript-cache.js";

const temporaryDirectories: string[] = [];

async function temporaryRollout(threadId: string, lines: unknown[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rollout-test-"));
  temporaryDirectories.push(root);
  const path = join(root, "sessions", `${threadId}.jsonl`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  return path;
}

function sessionMeta(threadId: string): unknown {
  return {
    type: "session_meta",
    payload: { id: threadId, cwd: "/workspace", timestamp: "2026-07-25T12:00:00.000Z" },
  };
}

/**
 * Writes a rollout, points `CODEX_HOME`/`CWD` at it for one hydration, and
 * restores both. One hydration per call: the transcript path cache is keyed
 * globally and only cleared in `afterEach`.
 */
async function hydrateRollout(
  threadId: string,
  lines: unknown[],
): Promise<Awaited<ReturnType<typeof hydrateMessagesFromPersistedSession>>> {
  const path = await temporaryRollout(threadId, lines);
  const previousHome = process.env.CODEX_HOME;
  const previousCwd = process.env.CWD;
  process.env.CODEX_HOME = dirname(dirname(path));
  process.env.CWD = "/workspace";
  try {
    return await hydrateMessagesFromPersistedSession(threadId);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    if (previousCwd === undefined) delete process.env.CWD;
    else process.env.CWD = previousCwd;
  }
}

afterEach(async () => {
  clearTranscriptPathCache();
  clearTranscriptCache();
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

  test("skips metadata beyond the bounded head without filling the transcript cache", async () => {
    const path = await temporaryRollout("oversized-head", [
      { type: "event_msg", payload: { message: "x".repeat(70 * 1024) } },
      {
        type: "session_meta",
        payload: {
          id: "oversized-head",
          cwd: "/workspace",
          timestamp: "2026-07-25T12:00:00.000Z",
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Recovered title" }],
        },
      },
    ]);

    expect(await getSessionMetaFromTranscriptPath(path)).toBeNull();
    expect(getTranscriptCacheStats()).toEqual({ entries: 0, bytes: 0 });
  });

  test("catalog aliases, malformed index lines, and generated title overrides are defensive", async () => {
    const root = await mkdtemp(join(tmpdir(), "rollout-catalog-"));
    temporaryDirectories.push(root);
    const transcriptPath = join(root, "sessions", "filename-alias.jsonl");
    await mkdir(dirname(transcriptPath), { recursive: true });
    await writeFile(transcriptPath, `${[
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "canonical-thread",
          cwd: "/workspace",
          timestamp: "2026-07-25T12:00:00.000Z",
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Prompt title" }],
        },
      }),
    ].join("\n")}\n`, "utf8");
    await writeFile(
      join(root, "session_index.jsonl"),
      `{malformed\n${JSON.stringify({
        id: "canonical-thread",
        updated_at: "2026-07-25T12:00:00.000Z",
      })}\n`,
      "utf8",
    );
    await persistSessionTitle(root, "canonical-thread", "Generated title", {
      source: "generated",
    });

    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = root;
    try {
      const catalog = await buildTranscriptCatalog();
      expect(catalog.transcriptPathByThreadId.get("filename-alias")).toBe(transcriptPath);
      expect(catalog.transcriptPathByThreadId.get("canonical-thread")).toBe(transcriptPath);

      const sessions = await listPersistedSessionsForCwd("/workspace");
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        id: "canonical-thread",
        title: "Generated title",
        titleSource: "generated",
      });
    } finally {
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
    }
  });

  test("cached and malformed metadata preserve caller fallbacks", async () => {
    const path = "/sessions/thread-cached.jsonl";
    const cached = {
      id: "different-id",
      title: "Prompt title",
      titleSource: "prompt" as const,
      updatedAt: "",
      cwd: "/workspace",
      transcriptPath: path,
    };
    const catalog = {
      metas: [cached],
      metaByPath: new Map([[path, cached]]),
      transcriptPathByThreadId: new Map([["thread-cached", path]]),
    };

    expect(
      await getPersistedSessionMeta(
        "thread-cached",
        "Indexed title",
        "2026-07-25T12:00:00.000Z",
        catalog,
      ),
    ).toMatchObject({
      id: "thread-cached",
      title: "Indexed title",
      titleSource: "codex",
      updatedAt: "2026-07-25T12:00:00.000Z",
    });

    const malformed = await temporaryRollout("malformed-meta-fallback", [{
      type: "session_meta",
      payload: { id: "" },
    }]);
    expect(
      await getPersistedSessionMeta(
        "malformed-meta-fallback",
        "Fallback",
        "2026-07-25T12:00:00.000Z",
        undefined,
        [malformed],
      ),
    ).toMatchObject({
      id: "malformed-meta-fallback",
      title: "Fallback",
      transcriptPath: malformed,
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
        { type: "output_text", text: 42 },
        { type: "future_content", text: "hidden" },
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

  /**
   * The record shapes here are the ones Codex actually writes, verified against
   * this repo's full rollout history: a `function_call` never carries `status`
   * (92,495 of 92,495 records), and a `custom_tool_call` always does. That
   * distinction drives the two different outcomes asserted below.
   */
  test("rehydrates persisted tool calls and results in assistant timeline order", async () => {
    const path = await temporaryRollout("thread-tools", [
      {
        type: "session_meta",
        payload: {
          id: "thread-tools",
          cwd: "/workspace",
          timestamp: "2026-07-25T12:00:00.000Z",
        },
      },
      { type: "turn_context", payload: { turn_id: "turn-tools", cwd: "/workspace" } },
      {
        timestamp: "2026-07-25T12:01:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Inspect the repository" }],
        },
      },
      {
        timestamp: "2026-07-25T12:01:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "I'll inspect it." }],
        },
      },
      {
        timestamp: "2026-07-25T12:01:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call-exec",
          arguments: JSON.stringify({ cmd: "git status --short" }),
        },
      },
      {
        timestamp: "2026-07-25T12:01:03.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-exec",
          output: " M src/example.ts",
        },
      },
      {
        timestamp: "2026-07-25T12:01:04.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "apply_patch",
          call_id: "call-patch",
          input: "*** Begin Patch",
          status: "completed",
        },
      },
      {
        timestamp: "2026-07-25T12:01:05.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-patch",
          output: "Patch applied to 1 file",
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "unknown-call",
          output: "must not create an orphan result",
        },
      },
      {
        timestamp: "2026-07-25T12:01:06.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "The repository has one modified file." }],
        },
      },
    ]);

    const previousHome = process.env.CODEX_HOME;
    const previousCwd = process.env.CWD;
    process.env.CODEX_HOME = dirname(dirname(path));
    process.env.CWD = "/workspace";
    try {
      const hydrated = await hydrateMessagesFromPersistedSession("thread-tools");
      expect(hydrated.messages).toHaveLength(2);
      expect(hydrated.messages[0]).toMatchObject({
        role: "user",
        content: "Inspect the repository",
        turnId: "turn-tools",
      });
      expect(hydrated.messages[1]).toMatchObject({
        role: "assistant",
        content: "The repository has one modified file.",
        turnId: "turn-tools",
      });
      expect(hydrated.messages[1]?.parts).toEqual([
        { type: "text", content: "I'll inspect it." },
        {
          type: "tool-invocation",
          content: "exec_command",
          toolName: "exec_command",
          toolArgs: {
            cmd: "git status --short",
            command: "git status --short",
          },
          // The rollout records no outcome for a function_call — not on the call
          // record, not on the output record, and not in the output text. The
          // result is shown without claiming it succeeded, because a failed
          // command produces exactly this same pair of records.
          toolState: undefined,
          toolTitle: "exec_command",
          toolOutput: " M src/example.ts",
          toolError: undefined,
        },
        {
          type: "tool-invocation",
          content: "apply_patch",
          toolName: "apply_patch",
          toolArgs: { input: "*** Begin Patch" },
          // A custom_tool_call does state its outcome, so that outcome is kept.
          toolState: "success",
          toolTitle: "apply_patch",
          toolOutput: "Patch applied to 1 file",
          toolError: undefined,
        },
        { type: "text", content: "The repository has one modified file." },
      ]);
    } finally {
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
      if (previousCwd === undefined) delete process.env.CWD;
      else process.env.CWD = previousCwd;
    }
  });

  /**
   * `status: "failed"` has not been observed in 34,640 sampled `custom_tool_call`
   * records — every one was `"completed"`. It is kept as a guard because it is
   * the counterpart value in the same field, so this test pins the branch rather
   * than documenting a shape Codex is known to emit.
   */
  test("a custom_tool_call that claims failure keeps that outcome", async () => {
    const hydrated = await hydrateRollout("thread-tool-failed", [
      sessionMeta("thread-tool-failed"),
      { type: "turn_context", payload: { turn_id: "turn-1", cwd: "/workspace" } },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "apply_patch",
          call_id: "call-patch",
          input: "*** Begin Patch",
          status: "failed",
        },
      },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-patch",
          output: "Patch did not apply",
        },
      },
    ]);

    expect(hydrated.messages[0]?.parts[0]).toMatchObject({
      toolState: "failure",
      toolOutput: undefined,
      toolError: "Patch did not apply",
    });
  });

  test("a failed tool result with no output text still reports an error", async () => {
    const hydrated = await hydrateRollout("thread-tool-failed-blank", [
      sessionMeta("thread-tool-failed-blank"),
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "apply_patch",
          call_id: "call-blank",
          input: "*** Begin Patch",
          status: "failed",
        },
      },
      {
        type: "response_item",
        payload: { type: "custom_tool_call_output", call_id: "call-blank" },
      },
    ]);

    // A failure with nothing to show must not render as a blank success.
    expect(hydrated.messages[0]?.parts[0]).toMatchObject({
      toolState: "failure",
      toolError: "Tool failed",
    });
  });

  test("a tool call whose result never arrived stays pending", async () => {
    const hydrated = await hydrateRollout("thread-tool-unpaired", [
      sessionMeta("thread-tool-unpaired"),
      { type: "turn_context", payload: { turn_id: "turn-1", cwd: "/workspace" } },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call-interrupted",
          arguments: JSON.stringify({ cmd: "sleep 600" }),
        },
      },
    ]);

    // The turn was interrupted before the result was written. "Still running" is
    // what the rollout records, so that is what is shown — inventing a terminal
    // state here would claim an outcome that never happened.
    const part = hydrated.messages[0]?.parts[0];
    expect(part).toMatchObject({ toolName: "exec_command", toolState: "pending" });
    expect(part?.toolOutput).toBeUndefined();
    expect(part?.toolError).toBeUndefined();
  });

  test("a turn of pure tool calls yields an assistant message with no text", async () => {
    const hydrated = await hydrateRollout("thread-tools-only", [
      sessionMeta("thread-tools-only"),
      { type: "turn_context", payload: { turn_id: "turn-1", cwd: "/workspace" } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Run the tests" }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call-1",
          arguments: JSON.stringify({ cmd: "bun test" }),
        },
      },
      {
        type: "response_item",
        payload: { type: "function_call_output", call_id: "call-1", output: "ok" },
      },
    ]);

    expect(hydrated.messages).toHaveLength(2);
    // The tool work is still surfaced even though the agent said nothing, so the
    // transcript does not silently lose the turn.
    expect(hydrated.messages[1]).toMatchObject({ role: "assistant", content: "" });
    expect(hydrated.messages[1]?.parts).toHaveLength(1);
    expect(hydrated.messages[1]?.parts[0]).toMatchObject({ toolName: "exec_command" });
  });

  test("tool calls do not leak across a turn boundary", async () => {
    const hydrated = await hydrateRollout("thread-two-turns", [
      sessionMeta("thread-two-turns"),
      { type: "turn_context", payload: { turn_id: "turn-1", cwd: "/workspace" } },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call-1",
          arguments: JSON.stringify({ cmd: "ls" }),
        },
      },
      {
        type: "response_item",
        payload: { type: "function_call_output", call_id: "call-1", output: "a.ts" },
      },
      { type: "turn_context", payload: { turn_id: "turn-2", cwd: "/workspace" } },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call-2",
          arguments: JSON.stringify({ cmd: "pwd" }),
        },
      },
      {
        type: "response_item",
        payload: { type: "function_call_output", call_id: "call-2", output: "/workspace" },
      },
    ]);

    // Two turns, two assistant messages — a merged bubble would make "fork from
    // here" target the wrong turn.
    expect(hydrated.messages).toHaveLength(2);
    expect(hydrated.messages.map((message) => message.turnId)).toEqual(["turn-1", "turn-2"]);
    expect(hydrated.messages.map((message) => message.parts.length)).toEqual([1, 1]);
  });

  test("a repeated call_id does not rewrite an earlier turn's result", async () => {
    const hydrated = await hydrateRollout("thread-duplicate-call", [
      sessionMeta("thread-duplicate-call"),
      { type: "turn_context", payload: { turn_id: "turn-1", cwd: "/workspace" } },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call-shared",
          arguments: JSON.stringify({ cmd: "ls" }),
        },
      },
      {
        type: "response_item",
        payload: { type: "function_call_output", call_id: "call-shared", output: "first" },
      },
      { type: "turn_context", payload: { turn_id: "turn-2", cwd: "/workspace" } },
      {
        type: "response_item",
        payload: { type: "function_call_output", call_id: "call-shared", output: "second" },
      },
    ]);

    expect(hydrated.messages).toHaveLength(1);
    expect(hydrated.messages[0]?.parts[0]).toMatchObject({ toolOutput: "first" });
  });

  test("falls back to a generic name and ignores a call with no call_id", async () => {
    const hydrated = await hydrateRollout("thread-tool-degraded", [
      sessionMeta("thread-tool-degraded"),
      {
        type: "response_item",
        payload: { type: "function_call", name: "   ", call_id: "call-unnamed", arguments: "{}" },
      },
      {
        type: "response_item",
        payload: { type: "function_call", arguments: JSON.stringify({ cmd: "ls" }) },
      },
      {
        type: "response_item",
        payload: { type: "function_call_output", call_id: "call-unnamed", output: "done" },
      },
    ]);

    const parts = hydrated.messages[0]?.parts ?? [];
    // Both calls are still shown; only the pairing degrades when call_id is absent.
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ toolName: "tool", toolOutput: "done" });
    expect(parts[1]).toMatchObject({ toolName: "tool", toolState: "pending" });
    expect(parts[1]?.toolOutput).toBeUndefined();
  });

  /**
   * Turn boundaries are what make "fork from here" survive a bridge restart, and
   * they are reconstructed from *two* record shapes: `turn_context`, and the
   * turn-scoped `event_msg` records. Both precede the messages of their turn, so
   * the last id seen owns the message. The camelCase spelling is accepted too, so
   * a rollout-format change degrades to "no fork point" rather than silently
   * attributing messages to the previous turn.
   */
  test("reconstructs turn boundaries from turn_context, event_msg, and either spelling", async () => {
    const root = await mkdtemp(join(tmpdir(), "rollout-turns-"));
    temporaryDirectories.push(root);
    const path = join(root, "sessions", "thread-turns.jsonl");
    await mkdir(dirname(path), { recursive: true });
    const records = [
      {
        type: "session_meta",
        payload: { id: "thread-turns", cwd: "/workspace", timestamp: "2026-07-25T12:00:00.000Z" },
      },
      // Before the first turn: no boundary has been seen yet.
      {
        timestamp: "2026-07-25T12:00:30.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "before any turn" }],
        },
      },
      { type: "turn_context", payload: { turn_id: "turn-a", cwd: "/workspace" } },
      {
        timestamp: "2026-07-25T12:01:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "first turn prompt" }],
        },
      },
      // The other ordering: a turn-scoped event_msg carrying the boundary.
      {
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-b" },
      },
      {
        timestamp: "2026-07-25T12:02:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "second turn answer" }],
        },
      },
      // camelCase: accepted, so a format change does not misattribute messages.
      { type: "event_msg", payload: { type: "task_started", turnId: "turn-c" } },
      {
        timestamp: "2026-07-25T12:03:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "third turn prompt" }],
        },
      },
      // Neither spelling, and a blank id: leaves the previous boundary standing
      // rather than clearing it.
      { type: "event_msg", payload: { type: "task_started", turn_id: "   " } },
      {
        timestamp: "2026-07-25T12:04:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "third turn answer" }],
        },
      },
    ];
    await writeFile(
      path,
      `${records.map((line) => JSON.stringify(line)).join("\n")}\n`,
      "utf8",
    );
    await writeFile(
      join(root, "session_index.jsonl"),
      `${JSON.stringify({ id: "thread-turns", updated_at: "2026-07-25T12:04:00.000Z" })}\n`,
      "utf8",
    );

    const previousHome = process.env.CODEX_HOME;
    const previousCwd = process.env.CWD;
    process.env.CODEX_HOME = root;
    process.env.CWD = "/workspace";
    try {
      const hydrated = await hydrateMessagesFromPersistedSession("thread-turns");
      expect(hydrated.messages.map((message) => [message.content, message.turnId])).toEqual([
        ["before any turn", undefined],
        ["first turn prompt", "turn-a"],
        ["second turn answer", "turn-b"],
        ["third turn prompt", "turn-c"],
        ["third turn answer", "turn-c"],
      ]);
    } finally {
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
      if (previousCwd === undefined) delete process.env.CWD;
      else process.env.CWD = previousCwd;
    }
  });
});
